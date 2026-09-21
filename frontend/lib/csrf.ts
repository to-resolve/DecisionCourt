// CSRF token 的**唯一**读取/拼装入口（double-submit cookie 模式的前端一侧）。
//
// ## 为什么要有这个模块
//
// 后端 `middleware.CSRF` 对所有非幂等方法（POST/PUT/DELETE）校验
// `Cookie: XSRF-TOKEN` 与 `Header: X-XSRF-TOKEN` 是否相等。前端凡是自己发
// POST 的地方**都必须**带上这个 header，否则 403。
//
// 历史教训（2026-09-21）：CSRF 是 v2.5 引入的，当时只改了 `lib/api.ts:fetchJson`。
// 而 `lib/transport.ts`（埋点上报）有**自己独立的 fetch**，只抄了 Authorization
// 没过抄 CSRF header → 线上每个埋点事件都 403：
//
//     POST /api/v1/courtrooms/<uuid>/events -> 403 CSRF_TOKEN_MISMATCH
//
// 所以把 token 读取逻辑收敛到这里，两边共用。**新增任何自定义 fetch 时，
// 都请用 csrfHeaders()，不要自己再抄一遍。**
//
// ## 与后端 Path 的耦合（重要）
//
// 后端把 `XSRF-TOKEN` 的 Path 设为 `/`（曾误设为 `/api/v1` 导致 JS 读不到，
// 详见 docs/adr/0041）。**`document.cookie` 只能看到 path 匹配当前文档 URL 的
// cookie**，所以一旦后端把 Path 改窄，这里就会读到 null，所有 POST 集体 403。

export const CSRF_COOKIE_NAME = "XSRF-TOKEN";
export const CSRF_HEADER_NAME = "X-XSRF-TOKEN";

// readCookie: 从 document.cookie 读取指定 cookie（SSR 安全）。
export function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null; // SSR safe
  const target = `${name}=`;
  const parts = document.cookie.split(";");
  for (const p of parts) {
    const trimmed = p.trim();
    if (trimmed.startsWith(target)) {
      // 后端用 gin 的 SetCookie 写入，值经过 url.QueryEscape；
      // 这里解码回原始 token，后端 c.Cookie() 会做同样的 QueryUnescape。
      return decodeURIComponent(trimmed.slice(target.length));
    }
  }
  return null;
}

// isStateChanging: 是否是需要 CSRF 校验的方法。
// 与后端 `middleware.CSRF` 的豁免逻辑对齐（GET/HEAD/OPTIONS 豁免）。
export function isStateChanging(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

/**
 * csrfHeaders: 返回该请求需要附加的 CSRF header。
 *
 * 幂等方法返回 `{}`（后端会自动 issue cookie）；
 * 非幂等方法且能读到 cookie 时返回 `{ "X-XSRF-TOKEN": <token> }`；
 * 读不到 cookie 时返回 `{}`（让后端回 403，由 errorBus 提示用户刷新）。
 */
export function csrfHeaders(method: string): Record<string, string> {
  if (!isStateChanging(method)) return {};
  const token = readCookie(CSRF_COOKIE_NAME);
  if (!token) return {};
  return { [CSRF_HEADER_NAME]: token };
}
