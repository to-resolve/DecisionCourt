// 随机 ID 工具：在**非安全上下文**下也能用。
//
// ## 为什么需要这个模块（2026-09-21 线上事故）
//
// `crypto.randomUUID()` 属于 Web Crypto API 中**要求安全上下文**的那一部分
// （与 `crypto.subtle` 一样）。安全上下文的定义是：HTTPS，或 localhost /
// 127.0.0.1 这类"潜在可信来源"。
//
// 本项目按「公网 IP + 端口」部署（绕开大陆 ICP 备案），访问地址形如
// `http://49.235.176.27:8080` —— **既不是 HTTPS 也不是 localhost**，
// 于是 `window.isSecureContext === false`，`crypto.randomUUID` 为 `undefined`。
// 已实测（真实 Chrome）：
//
//     crypto.randomUUID() → TypeError: crypto.randomUUID is not a function
//
// 直接调用它造成两处线上故障：
//   1. `CourtroomScene` 点「开庭」时抛 TypeError，请求根本没发出去 → 功能完全不可用
//   2. `generateUserID()` 退化成固定字符串 `"anon_placeholder"` → **所有访客共用
//      同一个匿名身份**，互相能看到对方创建的庭审（数据隔离失效，实测复现）
//
// ## 为什么退化用 `crypto.getRandomValues` 而不是 `Math.random`
//
// `crypto.getRandomValues()` **不要求安全上下文**（它是 Web Crypto 里少数
// 在非安全上下文也能用的接口），仍然是 CSPRNG，熵源可靠。
// `Math.random` 仅供极端兜底（连 getRandomValues 都没有的环境），不是 CSPRNG。

const HEX = "0123456789abcdef";

// randomBytes: 取 n 字节随机数。优先 CSPRNG，极端环境退化（见模块头注释）。
function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
    return bytes;
  }
  // 极端兜底：无 Web Crypto（老浏览器 / 特殊运行时）。安全性弱于 CSPRNG，
  // 但至少保证 ID 唯一，不至于把所有用户退化成同一个身份。
  for (let i = 0; i < n; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

// fallbackUUID: 生成符合 RFC 4122 v4 格式的 UUID（version=4 + variant=10xx），
// 与 `crypto.randomUUID()` 的输出格式完全一致（36 字符含连字符）。
function fallbackUUID(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

  let out = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += "-";
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return out;
}

/**
 * uuid: 生成 UUID v4 字符串（36 字符，含连字符）。
 *
 * 优先用原生 `crypto.randomUUID()`；在非安全上下文（纯 HTTP + 非 localhost）
 * 自动退化为 `crypto.getRandomValues()`。两条路径都返回同格式的 v4 UUID，
 * 调用方无需关心运行环境。
 *
 * ⚠️ 不要在业务代码里直接写 `crypto.randomUUID()` —— 统一走本函数，
 * 否则在 HTTP 部署下会直接抛 TypeError（见模块头注释）。
 */
export function uuid(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  return fallbackUUID();
}
