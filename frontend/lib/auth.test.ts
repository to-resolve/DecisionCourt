// lib/auth.ts 匿名身份测试
//
// 回归目标（2026-09-21 线上事故）：`generateUserID()` 原本写作
//
//     if (!isBrowser() || !crypto.randomUUID) return "anon_placeholder";
//
// 而本项目按「公网 IP + 端口」部署（http://<IP>:8080）时 `crypto.randomUUID`
// 为 undefined（非安全上下文）→ **所有访客都得到同一个 `anon_placeholder`**，
// 于是互相能看到对方创建的庭审（数据隔离失效，已用真实浏览器实测复现）。
//
// 本测试在无 randomUUID 的环境下断言身份仍然是**唯一且随机**的。

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";

// isBrowser() 要求 window + localStorage。测试环境是纯 Node（无 jsdom），
// 所以按需打桩，测完恢复。
function withBrowserGlobals<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const hadWindow = "window" in g;
  const hadLS = "localStorage" in g;
  const prevWindow = g.window;
  const prevLS = g.localStorage;

  const store = new Map<string, string>();
  g.window = {};
  g.localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };

  try {
    return fn();
  } finally {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
    if (hadLS) g.localStorage = prevLS;
    else delete g.localStorage;
  }
}

// 模拟非安全上下文：有 getRandomValues，没有 randomUUID
function withInsecureCrypto<T>(fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues: <U extends ArrayBufferView | null>(arr: U): U => {
        if (arr) randomFillSync(arr as unknown as NodeJS.ArrayBufferView);
        return arr;
      },
    },
  });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else delete (globalThis as { crypto?: unknown }).crypto;
  }
}

const BACKEND_WHITELIST = /^[A-Za-z0-9_.-]{1,64}$/;
const ANON_FORMAT = /^anon_[0-9a-f]{32}$/;

test("generateUserID: 非安全上下文不再退化成 anon_placeholder", async () => {
  const { generateUserID } = await import("./auth.ts");
  const id = withBrowserGlobals(() => withInsecureCrypto(() => generateUserID()));

  assert.notEqual(
    id,
    "anon_placeholder",
    "非安全上下文下必须仍是唯一身份；退化成固定串会让所有访客共享数据",
  );
  assert.match(id, ANON_FORMAT, `应为 anon_<32hex>，实际: ${id}`);
  assert.match(id, BACKEND_WHITELIST, "必须满足后端 user_id 白名单 [A-Za-z0-9_.-]{1,64}");
});

test("generateUserID: 非安全上下文下多次生成互不相同", async () => {
  const { generateUserID } = await import("./auth.ts");
  const ids = withBrowserGlobals(() =>
    withInsecureCrypto(() => new Set(Array.from({ length: 500 }, () => generateUserID()))),
  );
  assert.equal(ids.size, 500, `应产生 500 个不同身份，实际 ${ids.size} 个`);
});

test("getUserID: 身份写入 localStorage 且二次调用保持一致", async () => {
  const { getUserID } = await import("./auth.ts");
  const [a, b] = withBrowserGlobals(() =>
    withInsecureCrypto(() => [getUserID(), getUserID()]),
  );
  assert.match(a, ANON_FORMAT);
  assert.equal(a, b, "同一浏览器应复用同一身份（localStorage 缓存）");
});
