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

---

## 6. 验证

| 观测项 | 修复前（公网） | 修复后 |
|---|---|---|
| `POST .../start` | 200 | 200 |
| `POST .../events` | **403 `CSRF_TOKEN_MISMATCH` ×15+** | 200（待部署后实测确认） |
| 埋点请求携带的 header | `Content-Type` + `Authorization` | 再加 `X-XSRF-TOKEN` |
| `npm test`（Windows 本地） | 失败（cmd 不认 `$(find)`） | 117 pass / 0 fail |
| `test.yml` 重复 job key | 3 处 → 整个 workflow 可信度受损 | 0 处；jobs = 4 |
| CI 是否执行 auth/random/csrf 三个测试文件 | 否（不在硬编码清单里） | 是（glob 自动纳入） |

---

## 7. 通用教训

1. **"修一次漏一次"的根因不是手滑，是逻辑有多个副本。** 只要"哪些请求要带 CSRF header"这件事存在于两个地方，就一定会漂移。**正确做法是收敛成单一入口**，而不是把两处都改对一次。
2. **注入 fake 的测试测不到"真实实现自己漏了什么"。** 既有 12 项 transport 测试全用 fake fetcher，通过率 100%，bugs 照样上线。**对"我写了某个 header / 某个配置"这类断言，必须测真实实现**。
3. **硬编码测试文件清单 = 护栏会过期。** 新增测试文件不会自动进 CI，而且没有任何提示。用 glob / discovery。
4. **YAML 里注释不改变缩进层级。** 漏写一个 job ID，代码会被静默并入上一个 job；要么解析失败，要么"看起来在跑其实没跑"。**CI 配置本身也需要被检查**（本轮用一个 20 行的结构扫描脚本发现了它）。
5. **静默降级比报错更危险。** 缺 cookie 就悄悄不发埋点，比留一个 403 让控制台变红糟糕得多——后者会被发现。

---

## 8. 关联

- ADR 0041 —— CSRF Cookie Path 从 `/api/v1` 改为 `/`（同轮排查第 1 层根因）
- ADR 0042 —— 非安全上下文随机 ID 与匿名身份（同轮第 2、3 层根因）
- ADR 0020 —— 前端埋点设计（`lib/transport.ts` 的由来）
- `frontend/lib/csrf.ts`、`frontend/lib/csrf.test.ts`
- `frontend/lib/transport.ts`、`frontend/lib/api.ts`
- `.github/workflows/test.yml`、`frontend/package.json`
- `docs/learn/服务器部署实操手册.md` §19（埋点 CSRF 坑）、§20（CI 自身的两个静默缺陷）
