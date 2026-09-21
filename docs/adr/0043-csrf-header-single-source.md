# ADR 0043：埋点上报漏带 CSRF header —— CSRF 拼装逻辑收敛为单一入口

- **状态**：已实施
- **日期**：2026-09-21
- **影响范围**：`frontend/lib/csrf.ts`（新增）、`frontend/lib/transport.ts`、`frontend/lib/api.ts`、`frontend/lib/csrf.test.ts`（新增）、`frontend/package.json`、`.github/workflows/test.yml`
- **触发**：ADR 0041 / 0042 修完后用真实浏览器走完整开庭流程，发现 `/start` 已 200，但埋点上报连续 403
- **关联**：ADR 0041（CSRF Cookie Path）、ADR 0042（非安全上下文随机 ID）

---

## 1. 背景

前三层根因修完后（0041 cookie Path、0042 随机 ID 与匿名身份、表单契约），真实浏览器走完整流程已经是：

```
POST /api/v1/courtrooms               -> 200   （立案成功）
POST /api/v1/courtrooms/<uuid>/start  -> 200   （开庭成功）
庭审状态机 idle -> opening -> "开庭陈述结束"     （业务正常）
```

但同一次流程里，控制台仍有大量红色：

```
POST /api/v1/courtrooms/f059c63c-.../events -> 403 {"code":"CSRF_TOKEN_MISMATCH"}
```

一轮开庭实测触发 **15+ 次**该 403。

---

## 2. 根因：两个自定义 fetch，只修了一个

CSRF 是 v2.5 引入的（双提交 cookie 模式）。当时的改法是**在 `lib/api.ts` 的 `fetchJson` 里注入 header**：

```ts
// lib/api.ts（v2.5 引入）
if (httpMethod !== "GET" && httpMethod !== "HEAD" && httpMethod !== "OPTIONS") {
  const csrfToken = readCookie(CSRF_COOKIE_NAME);
  if (csrfToken) headers[CSRF_HEADER_NAME] = csrfToken;
}
```

问题是前端**不止一个发请求的地方**。`lib/transport.ts`（埋点上报，ADR 0020）有自己独立的 `defaultDeps().fetcher`，v0.10.1 时它还专门修过一次漏带 `Authorization` 的问题：

```ts
const authHeaders: Record<string, string> = { ...headers };
if (token) {
  authHeaders["Authorization"] = `Bearer ${token}`;   // ← 抄了鉴权
}
// ← CSRF header 没抄
```

于是埋点这条链路：**v0.10.1 修了 401，v2.5 又漏出 403**。同类问题修一次漏一次，因为"需要带哪些 header"这件事被抄在了两个地方。

### 2.1 为什么值得单独修（不是"埋点丢了就算了"）

| 影响 | 说明 |
|---|---|
| 观测能力归零 | `decision_events` 表收不到任何前端事件，MemoryAuditPanel / 埋点看板全是空的，而页面看起来"正常" |
| 持续噪声 | 失败事件会 `queue.push(event)` 回填重试 → 每 5s 一次 403，一轮开庭 15+ 条，日志里 CSRF 告警被淹没 |
| 掩盖真问题 | 后端看到的是"CSRF 校验在大量失败"，容易误判成攻击或 CSRF 实现有 bug |

---

## 3. 决策：把 CSRF 拼装收敛为单一入口

**新增 `frontend/lib/csrf.ts`，作为 CSRF token 读取/拼装的唯一实现，`api.ts` 与 `transport.ts` 共用。**

```ts
export const CSRF_COOKIE_NAME = "XSRF-TOKEN";
export const CSRF_HEADER_NAME = "X-XSRF-TOKEN";

readCookie(name)        // SSR 安全；值经 decodeURIComponent（对齐 gin 的 QueryEscape 写入）
isStateChanging(method) // GET/HEAD/OPTIONS 豁免，与后端一致
csrfHeaders(method)     // 非幂等且读得到 cookie 时返回 { "X-XSRF-TOKEN": token }，否则 {}
```

调用方各一行：

| 文件 | 改动 |
|---|---|
| `lib/transport.ts` | `Object.assign(authHeaders, csrfHeaders("POST"))`（埋点固定 POST） |
| `lib/api.ts` | 删掉重复的 `readCookie` + 两个常量，改为 `Object.assign(headers, csrfHeaders(httpMethod))` |

### 3.1 为什么把常量/函数搬进独立模块，而不是导出 api.ts 里的

`lib/transport.ts` 若 `import` 自 `lib/api.ts`，会把 `mockApi`、`errorBus`、`types` 一整条依赖链拖进埋点模块（transport 被浏览器入口引入，依赖越轻越好）。独立小模块让两边都只依赖 `lib/csrf.ts` 这一个 40 行文件。

### 3.2 缺 cookie 时返回 `{}` 而不是抛错（有意保留显式失败）

`csrfHeaders` 读不到 cookie 时返回空对象，请求照发，由后端回 403。

不在这里抛错/重试，是因为：**403 是一个明确的、可被 errorBus 呈现的信号**；如果改成"读不到就悄悄不发埋点"，问题会从"控制台报错"退化为"埋点永远无数据"，前者会被发现，后者不会。这与 ADR 0042 §8.2 的教训同源——**兜底不要退化成静默**。

### 3.3 未选择的方案

| 方案 | 不采用的原因 |
|---|---|
| 给 `transport.ts` 再抄一遍 CSRF 逻辑 | 就是这个 bug 的成因；第三次漏带只是时间问题 |
| 用 `axios` 拦截器统一注入 | 引入依赖 + 大范围改动，收益与"抽一个 40 行模块"相同 |
| 后端把 `/events` 端点改成 CSRF 豁免 | 该端点是写库的状态变更请求，豁免等于开一个 CSRF 缺口（可被第三方站点伪造埋点污染数据） |
| 让后端也接受 `X-Requested-With` 之类的弱校验 | 降级安全模型，不必要 |

---

## 4. 回归护栏

新增 `frontend/lib/csrf.test.ts`，共 12 项，分两层：

**第 1 层 — `lib/csrf.ts` 单元测试**（9 项）

| 测试 | 覆盖 |
|---|---|
| 从 `document.cookie` 取出 token | 正常路径 |
| cookie 不存在 → `null` | 缺 cookie |
| `XSRF-TOKEN-EVIL=hijack` 不被误匹配 | **前缀误匹配**（`startsWith("XSRF-TOKEN=")` 的经典坑） |
| SSR（无 `document`）→ `null` 不抛错 | SSR 安全 |
| 值经 URL 解码 | 对齐后端 `url.QueryEscape` |
| `isStateChanging` 对 GET/HEAD/OPTIONS 为 false，POST/PUT/DELETE/PATCH 为 true，小写也识别 | 与后端豁免逻辑对齐 |
| `csrfHeaders("POST")` 带 header 且不多带 | 正常路径 |
| `csrfHeaders("GET")` → `{}` | 幂等豁免 |
| 读不到 cookie → `{}` | 显式失败（见 §3.2） |

**第 2 层 — `defaultDeps().fetcher` 集成测试**（3 项）

这一层才是本 bug 的**直接护栏**：它跑的是 `lib/transport.ts` 里**真实的生产 fetcher**（不是注入的 fake），打桩 `window`/`document`/`localStorage`/`fetch` 后断言实际发出的 header。

| 测试 | 覆盖 |
|---|---|
| 埋点 POST 必须带 `X-XSRF-TOKEN`，且 `Authorization`、`Content-Type` 不丢 | **本次事故的直接回归** |
| 无 CSRF cookie 时不带该 header | 保持显式失败 |
| SSR（无 `window`）不发请求 | SSR 安全 |

> **为什么必须测真实 fetcher**：`transport.test.ts` 已有的 12 项全部用注入的 fake fetcher，只验证"传进去的 header 被透传"，**永远测不到 fetcher 自己漏带 header**。这正是这个 bug 能穿过 105 项既有测试上线的原因。

### 4.1 护栏有效性验证（变异测试）

把 `Object.assign(authHeaders, csrfHeaders("POST"))` 临时注释掉：

```
not ok 10 - defaultDeps().fetcher: 埋点 POST 必须带 X-XSRF-TOKEN（本次事故的直接护栏）
# pass 11 / fail 1
```

恢复后 12/12 通过。**护栏确实拦得住，不是"写了但当摆设"。**

### 4.2 全量测试

`npm test` → **117 项通过，0 失败**（此前脚本在 Windows 下因 `$(find ...)` 走 cmd shell 而失败，见 §5.2）。

---

## 5. 附带修正（同一轮发现，独立缺陷）

### 5.1 `test.yml` 里 `Doc cross-links` 漏写 job ID —— 整个 CI 可能没在跑

`.github/workflows/test.yml` 第 184 行附近：

```yaml
  # ============== Doc cross-links ==============
    name: Doc cross-links      # ← 4 空格缩进，但没有 `  doc-links:`
    runs-on: ubuntu-latest
    steps: ...
```

YAML 里注释不会关闭 block，这三行被**并进上一个 job `dep-audit` 的 mapping**，与它已有的 `name` / `runs-on` / `steps` 重复定义。据本地结构扫描：

```
[DUP] test.yml:185  job "dep-audit" 重复定义 key "name"（首次在 118）
[DUP] test.yml:186  job "dep-audit" 重复定义 key "runs-on"（首次在 119）
[DUP] test.yml:187  job "dep-audit" 重复定义 key "steps"（首次在 120）
```

后果二选一，都很难看：

1. **YAML 解析报 duplicate key** → 整个 `test.yml` 无效，CI 全不跑
2. **解析器 last-wins** → `dep-audit` 的 `steps` 被覆盖成"只跑 ADR 计数检查"，**`govulncheck` 与 `pnpm audit`（P1-6 依赖审计）静默不执行**，而看板上这个 job 依然叫 "Dependency audit"、依然显示绿色

### 5.1.1 实际命中的是第 1 种（已用 GitHub API 取证）

查 `971b99b` 之后每一次 push 的 Test 运行，全部 `conclusion=failure`，且**特征完全一致**：

```
name: ".github/workflows/test.yml"     ← 不是 "Test"，回落到文件路径
status: completed   conclusion: failure
created_at == updated_at               ← 瞬时失败（0 秒，没有任何 job 跑过）
jobs: total_count = 0                  ← 一个 job 都没有
check-runs: total_count = 0            ← 连 check 都没注册
```

`name` 回落成文件路径 + 0 job + 0 check-run + 瞬时失败，是 GitHub「**workflow 文件无效**」的确切签名。

**结论：`.github/workflows/test.yml` 自引入 `Doc cross-links` 那一次改动起，就再也没有执行过任何一个 job。** 不是"某个 job 静默跳过"，是**整条 CI 完全没跑**，而每次 push 的红色结论只表现为一个没有 job 的空运行。

修好后同一次 push（`b85e6e5`）立刻变了：

```
name: Test                     ← 正常
jobs: total_count = 4
Backend (Go)        => success
Doc cross-links     => success  ← 首次作为独立 job 存在
Frontend (Next.js)  => failure  ← 卡在 pnpm install（另一问题，见 §5.3）
Dependency audit    => failure  ← 卡在 pnpm install --frozen-lockfile（同上）
```

即：**一个漏写的 job ID，让整套 CI 静默失效了（无法从"红色"本身看出程度）。** 漏写的那 4 个空格，代价是一切自动化验证都没了。

无论命中哪一种，"CI 是绿的"这个信号都不可信。已补上 `  doc-links:` job ID，`jobs` 恢复为 4 个（`backend-test` / `frontend-test` / `dep-audit` / `doc-links`），重复 key 归零。

### 5.2 CI 前端测试是硬编码文件清单 —— 新护栏从来没跑过

`frontend-test` 的 Unit tests 步骤原本只列 4 个文件：

```yaml
pnpm exec node --experimental-strip-types --test \
  lib/transport.test.ts \
  lib/reconnect.test.ts \
  lib/analytics/analytics.test.ts \
  lib/analytics/runtime.test.ts
```

于是 **`lib/auth.test.ts`、`lib/random.test.ts`（ADR 0042 的护栏）和 `lib/csrf.test.ts`（本 ADR 的护栏）在 CI 里一次都没跑过**。写了护栏却不执行，是比"没写护栏"更隐蔽的失效——它会让人以为这类 bug 已经被防住了。

改为 glob（引号必须保留，交给 Node 自己展开 `**`；否则 shell 的 globstar 默认关闭，`**` 退化成 `*` 会漏掉 `lib/analytics` 等子目录）：

```yaml
pnpm exec node --experimental-strip-types --test "lib/**/*.test.ts"
```

同名修正也应用到 `frontend/package.json` 的 `test` 脚本：原 `$(find lib -name '*.test.ts')` 依赖 POSIX shell，在 Windows 上 npm 用 cmd 执行 `scripts` → 本地 `npm test` 直接失败。改成 glob 后跨平台一致（本地实测 117 项）。

> ⚠️ 只改 glob 还不够：当时 `frontend-test` job 卡在更前面的 `Install dependencies`，
> `Type check` / `Unit tests` / `Build` 三步全部 `skipped`，护栏依然不会跑。
> 直到 §5.3 的 `pnpm install` 问题修掉，glob 才真正生效（现已在 CI 里执行全部 117 项）。
> **"改了护栏"和"护栏在生效"是两件事，中间每一步依赖失败都会让前者白做。**

### 5.3 CI 里两个 job 的 `pnpm install` 都失败 —— 已定位并修复

修好 workflow 结构后，第一次真实运行暴露出：**两个需要装前端依赖的 job 都死在 install**。

| job | 失败步骤 | 后续步骤 |
|---|---|---|
| `Frontend (Next.js)` | `Install dependencies`（`pnpm install`） | `Type check` / `Unit tests` / `Build` **全部 skipped** |
| `Dependency audit` | `pnpm install (frozen lockfile)` | `pnpm audit (high+)` **skipped** |

#### 5.3.1 先把失败原因变成可读的

job 日志要鉴权才能通过 API 读（`/actions/jobs/<id>/logs` 对**公开仓库**也返回 403），
不带 token 时 step log 里只剩一句 `Process completed with exit code 1.`，等于没有信息量。

而 `/check-runs/<id>/annotations` **无需鉴权**。所以给两个 install 步骤加了
"失败时把日志尾部用 `::error::` workflow command 输出为 annotation"（退出码原样透传）：

```yaml
set +e
pnpm install 2>&1 | tee /tmp/pnpm-install.log
code=${PIPESTATUS[0]}
if [ "$code" -ne 0 ]; then
  esc=$(tail -c 2000 /tmp/pnpm-install.log | tr -d '\r' | sed ':a;N;$!ba;s/%/%25/g;s/\n/%0A/g')
  echo "::error title=pnpm install failed (exit $code)::$esc"
fi
exit $code
```

下一次运行立刻读到了真正的错误：

```
ERROR  packages field missing or empty
For help, run: pnpm help install
```

> 这一手是本次排查的关键技巧：**把"M 级信息"变成"无需鉴权即可程序化获取"的信息**，
> 否则只能靠人工点开网页。值得长期保留。

#### 5.3.2 根因：pnpm 9 与 pnpm 10/11 的配置文件代际差异

`frontend/pnpm-workspace.yaml`（**上游带的、已入库**）：

```yaml
allowBuilds:
  unrs-resolver: true
```

- 这是 **pnpm 10/11 的新式写法**：`allowBuilds` 这类设置只能写在
  `pnpm-workspace.yaml` 里，所以**即使不是 monorepo 也会有这个文件，且没有 `packages:`**
- **pnpm 9 只要看到该文件，就强制要求 `packages:` 字段，缺失即报错退出**
- CI 固定 `pnpm 9`（`pnpm/action-setup@v4 with version: 9`），本地是 **pnpm 11.18.0** → 只有 CI 挂

#### 5.3.3 为什么这个失败从没被人看到（"本地过 / Docker 过 / 只有 CI 挂"）

| 环境 | 是否看到 `pnpm-workspace.yaml` | 结果 |
|---|---|---|
| 本地开发（pnpm 11.18） | 看到，但接受"无 `packages`"的写法 | ✅ 通过 |
| 服务器 Docker 构建（`corepack prepare pnpm@9.15.4`） | **看不到** —— `frontend/Dockerfile` 只 `COPY package.json pnpm-lock.yaml`，没拷这个文件 | ✅ 通过 |
| GitHub CI（pnpm 9） | 看到 | ❌ `packages field missing or empty` |

三者叠加：本地复现不出来、Docker 复现不出来、而 CI 又因为 §5.1 的 workflow 无效
压根没跑过 —— 于是一个 **100% 必现的失败**隐身了很久。

#### 5.3.4 修法与验证

加 `packages: ["."]`（前端不是 monorepo，声明"只有根包"）。两版 pnpm 均实测：

| 命令 | 结果 |
|---|---|
| `pnpm@9.15.9 install --frozen-lockfile --lockfile-only`（修复前） | ❌ `ERROR packages field missing or empty` —— **与 CI 报错逐字一致** |
| `pnpm@9.15.9 install --frozen-lockfile --lockfile-only`（修复后） | ✅ `Done in 1.2s` |
| `pnpm@11.18.0 install --frozen-lockfile --lockfile-only`（修复后） | ✅ `Done in 16s` |

> 反向验证的价值：**先在本地复现出与 CI 一模一样的报错**，再改代码让它消失。
> 比"改一版推上去看绿不绿"快得多，而且能证明因果。

修好后 `Test` workflow 首次全绿：

```
Backend (Go)       => success   (go vet / build / unit tests)
Frontend (Next.js) => success   (Install / Type check / Unit tests / Build)  ← 首次全部执行
Dependency audit   => success   (install / pnpm audit)
Doc cross-links    => success   (首次作为独立 job 存在)
```

**至此 §5.2 的 glob 改动才真正生效** —— `lib/**/*.test.ts`（117 项，含本 ADR 的
CSRF 护栏）第一次在 CI 里被执行。在此之前，"护栏"两个字是假的。

#### 5.3.5 连带效应（⚠️ 需要决策）

`Deploy` workflow 由 `workflow_run: Test → completed` 触发、且 gate 在
`Test.conclusion == 'success'`。**Test 从没成功过 → Deploy 一直 skipped；现在 Test 绿了
→ 每次推 main 都会真跑 Deploy，而它第一步 `Login to ACR` 就失败**（阿里云 ACR 凭据已失效，
项目早已迁到腾讯云 CVM + tar + docker compose 手工部署）。

失败发生在 `Login to ACR`，`Build & push` 与 `Deploy to ECS` 全部 skipped →
**没有产出镜像、没有 SSH 到任何服务器**，是"红但不危险"。但一条永远红的流水线会掩盖
真正的失败信号（与本 ADR 的主线教训同源）。

可选处置（属部署策略，需用户决定，不在本 ADR 擅自变更范围内）：

1. 把 `deploy.yml` 的触发器收敛为 `push tags` + `workflow_dispatch`，去掉
   `workflow_run`（推荐：与"已不用 ACR/ECS"的现状一致，发版改由 tag 驱动）
2. 若仍要保留 CI/CD，则更新 ACR / ECS 相关 Secrets 并重定向到现有服务器
3. 在 GitHub UI 里 disable 该 workflow（最省事，但配置漂移会留在仓库里）

---

## 6. 验证

| 观测项 | 修复前（公网） | 修复后（公网实测） |
|---|---|---|
| `POST .../start` | 200 | 200 |
| `POST .../events` | **403 `CSRF_TOKEN_MISMATCH` ×15+** | **200 ×1，403 = 0** |
| 埋点请求携带的 header | `Content-Type` + `Authorization` | 追加 `X-XSRF-TOKEN`（实测 `csrf=有`） |
| `decision_events` 表（该庭审） | 前端事件 0 行 | `fe.trial_started` / `state_transition` 各 1 行，`status=ok` |
| 页面错误 | 15+ 条 403 error | 无 |
| `npm test`（Windows 本地） | 失败（cmd 不认 `$(find)`） | 117 pass / 0 fail |
| `test.yml` 是否真的执行 | **从未执行**（文件无效，0 job） | 4 job 全绿 |
| CI 是否执行 auth/random/csrf 三个测试文件 | 否（文件从未被解析） | ✅ 是（glob，117 项，Unit tests 步骤 success） |
| CI 里 `pnpm install` | 两个 job 都失败（`packages field missing or empty`） | ✅ 两个 job 都成功 |
| `Deploy` workflow | 一直被 skip（Test 从未成功） | 开始真跑并失败在 `Login to ACR` —— 见 §5.3.5（待决策） |

### 6.1 公网验证原始输出（关键片段）

```
===== 1) 打开 http://49.235.176.27:8080/ =====
  isSecureContext = false
  XSRF-TOKEN 在 document.cookie 里 = true

===== 2) 立案 =====
  pathname = /court/8b707f81-0778-4a69-93b9-4828b35a128a

===== 4) /events 请求明细 =====
  200  csrf=有(LjE3ODk5…)  auth=yes  cookie=no

===== 5) 结论 =====
  403 数量        = 0  ✅
  2xx 数量        = 1  ✅
  漏带 CSRF 的请求 = 0  ✅ 全部带上了 X-XSRF-TOKEN

--- 页面错误 ---
  无
```

服务端落库确认：

```
    event_type    | status | count
------------------+--------+-------
 fe.trial_started | ok     |     1
 state_transition | ok     |     1
```

> 请求数从"15+ 次 403"变成"1 次 200"是符合预期的：以前是**同一个事件失败后回填队列、每 5s 重试**，
> 看起来数量多其实只有 1 个事件在反复撞墙；现在一次成功就出队，不再重试。

---

## 7. 通用教训

1. **"修一次漏一次"的根因不是手滑，是逻辑有多个副本。** 只要"哪些请求要带 CSRF header"这件事存在于两个地方，就一定会漂移。**正确做法是收敛成单一入口**，而不是把两处都改对一次。
2. **注入 fake 的测试测不到"真实实现自己漏了什么"。** 既有 12 项 transport 测试全用 fake fetcher，通过率 100%，bugs 照样上线。**对"我写了某个 header / 某个配置"这类断言，必须测真实实现**。
3. **硬编码测试文件清单 = 护栏会过期。** 新增测试文件不会自动进 CI，而且没有任何提示。用 glob / discovery。
4. **YAML 里注释不改变缩进层级。** 漏写一个 job ID，代码会被静默并入上一个 job；要么解析失败，要么"看起来在跑其实没跑"。**CI 配置本身也需要被检查**（本轮用一个 20 行的结构扫描脚本发现了它）。
5. **静默降级比报错更危险。** 缺 cookie 就悄悄不发埋点，比留一个 403 让控制台变红糟糕得多——后者会被发现。
6. **"从没跑过"和"跑了但失败"在界面上都是红色。** 查 CI 的第一步应该是确认
   "这次运行到底有几个 job"，而不是看红绿（`name` 是否回落到文件路径是最好用的判据）。
7. **工具链的"代际差异"会在最难发现的地方咬人。** 同一份配置，pnpm 11 接受、pnpm 9 拒绝；
   本地过、Docker 过（因为它没 COPY 那个文件）、只有 CI 挂。**凡是有版本锁定的地方，
   都存在这种"只在某一个环境成立"的失败** —— 唯一可靠的验证是**在那个环境里跑**。
8. **先把 CI 的错误变成"可程序化读取"的，再排查。** job log 要鉴权，但
   `::error::` annotation 不要。花 10 行 YAML 把 M 级信息升一级，后面每一次排查都受益。
9. **先在本地复现出与 CI 逐字一致的报错，再改代码。** 本轮的
   `pnpm@9 install --frozen-lockfile --lockfile-only` 复现 → 改 → 复验，比"推上去看绿不绿"
   快一个数量级，而且建立了因果，不是碰巧。

---

## 8. 关联

- ADR 0041 —— CSRF Cookie Path 从 `/api/v1` 改为 `/`（同轮排查第 1 层根因）
- ADR 0042 —— 非安全上下文随机 ID 与匿名身份（同轮第 2、3 层根因）
- ADR 0020 —— 前端埋点设计（`lib/transport.ts` 的由来）
- `frontend/lib/csrf.ts`、`frontend/lib/csrf.test.ts`
- `frontend/lib/transport.ts`、`frontend/lib/api.ts`
- `.github/workflows/test.yml`、`frontend/package.json`、`frontend/pnpm-workspace.yaml`
- `docs/learn/服务器部署实操手册.md` §19（埋点 CSRF 坑）、§20（CI 自身的静默缺陷）
