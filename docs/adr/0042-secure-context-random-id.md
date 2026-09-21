# ADR 0042：纯 HTTP 部署（非安全上下文）下的随机数与匿名身份

- **状态**：已实施
- **日期**：2026-09-21
- **影响范围**：`frontend/lib/random.ts`（新增）、`frontend/lib/auth.ts`、`frontend/components/courtroom/CourtroomScene.tsx`
- **触发**：修复 CSRF 403（ADR 0041）后，公网地址点「开庭」抛出 `TypeError`，并发现匿名身份塌缩导致数据串号
- **关联**：ADR 0041（同一轮排查中发现，根因类别不同但同属"只在真实浏览器里暴露"的问题）

---

## 1. 背景

本项目按「公网 IP + 端口」部署（`http://49.235.176.27:8080`），目的是绕开大陆节点的 ICP 备案要求（详见部署手册 §6.1）。

这个部署形态落在 **非安全上下文**：标准定义的安全上下文是 HTTPS，或 `localhost` / `127.0.0.1` 这类"潜在可信来源"。公网 IP 走明文 HTTP **既不是 HTTPS 也不是 localhost**，实测：

```
window.isSecureContext      === false
typeof crypto.randomUUID    === "undefined"
```

**关键陷阱：本地 `localhost` 是安全上下文，所以这两个问题在本地开发时完全复现不出来**，只有打公网 IP 才暴露。

---

## 2. 问题一：点「开庭」直接抛 TypeError

`frontend/components/courtroom/CourtroomScene.tsx` 用它生成 Idempotency-Key：

```ts
startTrialIdempKeyRef.current = crypto.randomUUID();
```

非安全上下文下 `crypto.randomUUID` 是 `undefined`，调用即抛。实测（真实 Chrome，公网地址）：

```
crypto.randomUUID() 调用结果 → 抛异常: TypeError: crypto.randomUUID is not a function
点击按钮: 开 庭
--- 非 GET 的 API 调用 ---
  POST /api/v1/auth/anon -> 200        ← 只有鉴权请求，立案/开庭请求根本没发出去
--- 页面错误 ---
  crypto.randomUUID is not a function
```

即：**功能完全不可用，且错误发生在发请求之前**，后端日志里什么都看不到。

---

## 3. 问题二：匿名身份塌缩 → 数据隔离失效（更严重）

`frontend/lib/auth.ts` 原实现：

```ts
if (!isBrowser() || !crypto.randomUUID) {
  return "anon_placeholder";      // ← 固定字符串
}
```

非安全上下文下所有访客都拿到同一个 `anon_placeholder`，而它是 JWT 的 `sub`、也是后端数据归属的 `owner_id`。实测：

```
--- 本次生成的匿名身份 ---
  localStorage user_id = anon_placeholder
  /auth/anon 返回的 user_id = anon_placeholder
--- 该身份能看到的庭审列表 ---
  {"code":0,"data":{"count":2, ... "session_uuid":"c96264af-..."}}
```

**用一个全新的浏览器（空 localStorage）打开首页，直接看到了之前其它会话创建的 2 条庭审记录。**

后果：
- 任何访客都能列出、打开、继续操作别人创建的庭审
- 后端的 owner 校验形同虚设（因为 owner 就是同一个共享 ID）
- 拿公网链接去演示，等于把所有人的记录放在同一个账本里

这属于**隐私/数据隔离缺陷**，比功能不可用更值得优先处理。

---

## 4. 决策

**新增 `frontend/lib/random.ts`，提供环境无关的 `uuid()`：优先原生 `crypto.randomUUID()`，在非安全上下文自动退化为 `crypto.getRandomValues()`。**

### 4.1 为什么退化用 `getRandomValues` 而不是 `Math.random`

Web Crypto 里「要求安全上下文」的只有 `crypto.randomUUID()` 和 `crypto.subtle`；
**`crypto.getRandomValues()` 在任何上下文都可用**，且同样是 CSPRNG、熵源可靠。
所以这是**不损失安全性**的降级路径。

`Math.random` 只保留为极端兜底（连 `getRandomValues` 都没有的运行时），不是 CSPRNG。

### 4.2 实现要点

`getRandomValues` 给出 16 字节后需**手工补 v4 位**，保证与 `crypto.randomUUID()` 输出同构：

```
bytes[6] = (bytes[6] & 0x0f) | 0x40;   // version 4
bytes[8] = (bytes[8] & 0x3f) | 0x80;   // variant 10xx
```

调用点统一改为：

| 文件 | 改动 |
|---|---|
| `lib/auth.ts` | `generateUserID()` 改用 `uuid()`；`anon_placeholder` 只保留给 SSR（无 DOM/crypto 且不会被持久化的场景） |
| `components/courtroom/CourtroomScene.tsx` | Idempotency-Key 改用 `uuid()` |

### 4.3 未选择的方案及原因

| 方案 | 不采用的原因 |
|---|---|
| 全站改 HTTPS（上域名 + 证书） | 需要域名 + ICP 备案（大陆节点），属第 3 阶段计划；且不能解决"代码不该直接依赖安全上下文"这一根因 |
| 把 `anon_placeholder` 换成 `Date.now() + Math.random()` | 非 CSPRNG，身份可被预测/枚举，与后端"不可枚举"的设计前提冲突 |
| 后端为匿名用户下发 ID | 改动面大，且前端首次请求就已有身份概念；本 ADR 只修可在前端闭环的问题 |

---

## 5. 回归护栏

新增 `frontend/lib/random.test.ts`（5 个）+ `frontend/lib/auth.test.ts`（3 个）。测试用 Node 内置 runner（`node --experimental-strip-types --test`），通过 `Object.defineProperty` 替换 `globalThis.crypto` 来模拟非安全上下文：

| 测试 | 覆盖 |
|---|---|
| 默认环境返回合法 v4 UUID | 正常路径 |
| **无 `randomUUID` 时不抛异常且返回合法 v4** | 本 ADR 的核心回归（原代码直接抛） |
| 完全没有 `crypto` 时仍返回合法 v4 | 极端兜底分支 |
| 非安全上下文下 2000 次调用不重复 | 唯一性 |
| v4 版本位/变体位正确 | 格式正确性 |
| **`generateUserID` 非安全上下文不再退化成 `anon_placeholder`** | 数据隔离回归 |
| 非安全上下文下 500 次生成互不相同 | 身份唯一性 |
| `getUserID` 写入 localStorage 且二次调用一致 | 缓存行为 |

全量前端测试：**105 项通过**（新增 8 项）。

---

## 6. 附带修正：「立案」表单的字段标注与后端契约不符

同一轮排查中发现（**独立缺陷**，已一并修正）：表单把选项 A/B 标注为
「选填 · 不填将由 Agent 协助生成」，但后端 `internal/courtroom/service.go:358`
明确要求二者非空（`"option_a and option_b are required for MVP"`），且前端
`optionA.trim() || undefined` 会让空值被 `JSON.stringify` 丢弃。实测：

```
选项留空提交 → 请求体 {"title":"...","mode":"standard"}   ← option_a/option_b 消失
            → 400 {"code":1001,"message":"invalid request body"}
```

代码里没有"自动生成选项"的分支（quick/standard/deep 只是轮次不同），所以 UI 的标注是错的；`lib/mock/mockApi.ts` 里的 `option_a && option_b ? "idle" : "clarification"` 是 mock 独有的旧流程。

修正：Label 改为「必填」、两个 Input 加 `required`、`handleSubmit` 按 `trim()` 前置校验并给出可读提示（HTML `required` 对"纯空格"放行，故需 `trim` 判断）。

> 若产品确实希望「选填 → Agent 协助生成」，那是一个**新功能**（需后端支持空选项并触发澄清流程），不在本次缺陷修复范围内。

---

## 7. 验证

| 观测项 | 修复前（公网） | 修复后 |
|---|---|---|
| `window.isSecureContext` | false | false（部署形态未变） |
| `typeof crypto.randomUUID` | `"undefined"` | `"undefined"`（但代码不再直接依赖它） |
| `crypto.randomUUID()` | TypeError | 不再被调用 |
| 点「开庭」 | TypeError，无请求 | 正常发出请求 |
| 匿名身份 | `anon_placeholder`（全体共享） | `anon_<32hex>`（每人唯一） |
| 全新浏览器看到的庭审数 | 2（别人的） | 0（自己的） |
| 填全字段立案 | 403 → 修复 0041 后 200 | 200 + 跳转 `/court/<uuid>` |
| 选项留空提交 | 400 `invalid request body` | 前端拦下 + 可读提示，不发请求 |

---

## 8. 通用教训

1. **`localhost` 是安全上下文，公网 IP 不是** —— 依赖安全上下文的 API（`randomUUID` / `subtle` / Service Worker / 剪贴板）**在本地测不出问题**，必须用真实浏览器打公网地址验证。
2. **"兜底返回固定值"是危险模式**：为了「老浏览器可用」而返回一个共享的常量身份，静默地把一个功能问题升级成了数据隔离问题。不确定时应该抛错或生成随机值，而不是让所有人共用同一个值。
3. **服务端 curl 无法替代浏览器验证**：`document.cookie` 可见性、安全上下文判定、CSP、preflight 都在浏览器侧。本 ADR 与 ADR 0041 两个缺陷 curl 全程测不出来。

---

## 9. 关联

- ADR 0041 —— CSRF Cookie Path 修复（同轮排查发现，同属"只在真实浏览器里暴露"）
- `frontend/lib/random.ts`、`frontend/lib/random.test.ts`、`frontend/lib/auth.test.ts`
- `docs/learn/服务器部署实操手册.md` §13–§16（HTTP 部署坑位）
