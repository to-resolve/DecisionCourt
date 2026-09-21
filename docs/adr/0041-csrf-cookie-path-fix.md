# ADR 0041：CSRF Token Cookie 的 Path 必须为 `/`

- **状态**：已实施
- **日期**：2026-09-21
- **影响范围**：`backend/internal/middleware/csrf.go`（1 行）、`frontend`（无改动）
- **触发**：线上 + 本地「点击立案开庭」100% 报 `403 Forbidden`
- **Supersedes**：ADR 0039 §3 中「Cookie Path=/api/v1」的相关设计假设

---

## 1. 问题

部署到 v2.6 后，首页点击「立案 · 开庭」必定失败，浏览器控制台：

```
POST http://localhost/api/v1/courtrooms 403 (Forbidden)
Uncaught (in promise) Error: API error: 403 Forbidden
```

本地与线上（`http://49.235.176.27:8080`）现象完全一致。后端响应体：

```json
{"code":"CSRF_TOKEN_MISMATCH","message":"CSRF token mismatch"}
```

注意是 **403 而不是 401** —— 说明鉴权已通过（token 有效），是 CSRF 中间件拒的。

---

## 2. 根因

`middleware.CSRF` 采用 double-submit cookie 模式，链路要求「前端能把 cookie 值读到并复制进 header」：

| 环节 | 实现 |
|---|---|
| 后端签发 | `GET /api/v1/*` 时 `Set-Cookie: XSRF-TOKEN=<token>; Path=/api/v1` |
| 前端读取 | `lib/api.ts` 的 `readCookie("XSRF-TOKEN")` → **`document.cookie`** |
| 前端回填 | POST/PUT/DELETE 时放进 `X-XSRF-TOKEN` header |
| 后端校验 | `c.Cookie("XSRF-TOKEN")` 与 header 做恒定时间比较 |

问题出在 `CookiePath: "/api/v1"`。原代码注释写的理由是「让 JS 在 API 请求域下读得到」，**这个推理是错的**：

> **RFC 6265 §5.4**：`document.cookie` 只暴露 path 能匹配**当前文档 URL** 的 cookie；
> 而 `Set-Cookie` 的 path 匹配的是**请求 URL**。两者是不同的匹配对象。

前端页面位于 `/`（以及 `/court/*`、`/verdict/*`），文档路径永远匹配不上 `/api/v1`。于是：

```
document.cookie                 →  ""            （前端读不到 token）
POST /api/v1/courtrooms         →  浏览器自动带 cookie（请求 URL 匹配上了）
                                  但 X-XSRF-TOKEN header 为空
                                →  403 CSRF_TOKEN_MISMATCH
```

这是 double-submit 模式最隐蔽的失效方式：**cookie 在链路上其实一直在传，只有 JS 看不见**。

### 2.1 为什么原有 10 个单测全绿

`csrf_test.go` 用 `httptest` 直接构造请求与 cookie，**不模拟 `document.cookie` 的可见性语义**——它只验证中间件逻辑（比较、验签、时效）。所有测试都绕过了"浏览器能不能读到"这一环，因此完全无法暴露该缺陷。

> 教训：**安全中间件的测试如果只在服务端打转，就会漏掉"浏览器侧是否可达"这一整类问题。**

---

## 3. 实测证据（真实浏览器，非推断）

用系统 Chrome + puppeteer-core 走完整用户流程，修复前后对照：

| 观测项 | 修复前 | 修复后 |
|---|---|---|
| `document.cookie` 可见的 cookie 名 | `[]`（空） | `["XSRF-TOKEN"]` |
| XSRF-TOKEN 的实际 path（CDP 视角） | `/api/v1` | `/` |
| POST 是否带 `X-XSRF-TOKEN` | 否 | **是** |
| `POST /api/v1/courtrooms` | **403** `CSRF_TOKEN_MISMATCH` | **200**，跳转 `/court/<uuid>` |
| 页面错误 | `API error: 403 Forbidden` | 无 |

修复前 `document.cookie` 为空这一点是决定性的：它直接证明前端 `readCookie()` 必然返回 `null`。

---

## 4. 决策

**将 `CookiePath` 改为 `/`。**

理由：

1. **double-submit 模式的前提就是 JS 必须能读到 cookie**。任何非根路径都等于自废武功。业界惯例（Angular `XSRF-TOKEN`、Laravel `XSRF-TOKEN`）均使用 `Path=/`。
2. **不降低安全性**。CSRF token 不是凭据——它只用于证明"请求来自同源脚本"，本来就设计为可被同源 JS 读取。真正的会话凭据 `dc_session` 仍是 `HttpOnly`（JS 读不到）。
3. **Path 变宽不改变后端读取行为**：cookie 会随所有同源请求发送，而原路径 `/api/v1` 也已覆盖全部 API 请求。差异仅在静态资源请求上多带一个约 200 字节的 cookie，可忽略。
4. **改动面最小**：后端 1 行，前端无需改动（前端已正确实现 `decodeURIComponent`）。

### 4.1 转义链路复核（确保往返一致）

修复后 cookie 从 `/` 可读，必须确认前后端解码规则一致，否则会从一个 403 换成另一个 403：

```
后端 gin.SetCookie  →  url.QueryEscape(token)     // 浏览器存储的就是这个转义值
浏览器 document.cookie → 转义值
前端 readCookie()     →  decodeURIComponent(...)  // 解码 → 原始 token → 放 header
后端 c.Cookie()       →  url.QueryUnescape(...)   // 解码 → 原始 token
```

- 前端 `decodeURIComponent` 与后端 `url.QueryUnescape` 的唯一差别是 **`+` 的处理**（后者把 `+` 当空格）。
- 因为 gin 的 `QueryEscape` 会把所有 `+` 编成 `%2B`，**存储值中永远不会出现裸 `+`**，所以两者等价。
- 新增测试 `TestCSRF_BrowserRoundTrip` 用 `url.PathUnescape`（≡ `decodeURIComponent`）模拟前端，并断言存储值不含裸 `+`，把这条不变量固化下来。

---

## 5. 回归护栏

新增 2 个测试（`csrf_test.go`）：

| 测试 | 作用 |
|---|---|
| `TestCSRF_IssuedCookiePathIsRoot` | **断言 `Path == "/"`**。这是唯一能在单测层抓住本类问题的断言，已实测：把 Path 改回 `/api/v1` 时该测试立即 FAIL 并打印原因 |
| `TestCSRF_BrowserRoundTrip` | 跑 30 轮 token，取 `Set-Cookie` 的转义值当 cookie、`PathUnescape` 后当 header，断言 200；并断言至少一轮出现转义、且存储值不含裸 `+` |

`TestCSRF_BrowserRoundTrip` 覆盖的是"真实链路两端值不同"这一点——原 `TestCSRF_PostSucceedsWithMatchingTokens` 把同一个值同时当 cookie 和 header，属于简化失真。

---

## 6. 与本地上游同步的关系

⚠️ 这是**对上游代码的修改**。`backend/internal/middleware/csrf.go` 属于「我们与上游差异清单」，后续 `git checkout upstream/main -- .` 同步时必须重放本修复（见 `.workbuddy/memory/MEMORY.md` §3）。

已在上游方向同步（上游同样存在此缺陷，v2.5 引入 CSRF 时即存在）。

---

## 7. 关联

- ADR 0039 §3（CSRF Token 中间件首次实施）—— 本 ADR 修正其 Cookie Path 假设
- 事故现象同时暴露了另一独立缺陷：「立案」表单把选项 A/B 标注为"选填"，但后端 `service.go` 强制要求二者非空（`option_a and option_b are required for MVP`）。该问题与本 ADR 无关，单独立项处理。
