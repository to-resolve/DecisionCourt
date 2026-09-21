// lib/csrf.ts + lib/transport.ts 埋点 CSRF header 回归测试
//
// ## 回归目标（2026-09-21 线上事故）
//
// CSRF 双提交 cookie 模式是 v2.5 引入的，当时只改了 `lib/api.ts:fetchJson`。
// `lib/transport.ts`（埋点上报）有**自己独立的 fetch**，只抄了 Authorization，
// 没过抄 `X-XSRF-TOKEN`。于是线上每一条埋点事件都失败：
//
//     POST /api/v1/courtrooms/<uuid>/events -> 403 {"code":"CSRF_TOKEN_MISMATCH"}
//
// 而且失败事件会回填队列重试 → 形成"每 5s 一次、连续 15+ 次"的 403 噪声
// （实测一次开庭触发）。
//
// 本测试分两层：
//   1. `lib/csrf.ts` 单元测试 —— token 读取 / 方法豁免 / SSR 安全
//   2. `defaultDeps().fetcher` 集成测试 —— **直接断言真实生产 fetcher 会带
//      CSRF header**。这层是真正的护栏：只要有人再写一个不带 CSRF 的自定义
//      fetch，或者改动读 cookie 的逻辑，这里就会红。
//
// 跑测试命令：
//   node --experimental-strip-types --test frontend/lib/csrf.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  csrfHeaders,
  isStateChanging,
  readCookie,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "./csrf.ts";

// ============== 测试 helper ==============

/** withDocument: 临时打桩 document.cookie，测完恢复。 */
function withCookie<T>(cookie: string, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const hadDocument = "document" in g;
  const prevDocument = g.document;

  g.document = {
    get cookie(): string {
      return cookie;
    },
  };

  try {
    return fn();
  } finally {
    if (hadDocument) g.document = prevDocument;
    else delete g.document;
  }
}

/** withoutDocument: 模拟 SSR（无 document）。 */
function withoutDocument<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const hadDocument = "document" in g;
  const prevDocument = g.document;
  delete g.document;

  try {
    return fn();
  } finally {
    if (hadDocument) g.document = prevDocument;
  }
}

/**
 * withBrowserEnv: 同时打桩 window / document / localStorage / globalThis.fetch，
 * 用于跑 defaultDeps() 这种"生产默认依赖"的真实实现。
 *
 * localStorage 里预置一个**未过期** token，让 ensureAuthToken() 走缓存分支、
 * 不发起额外的 /auth/anon 请求 —— 这样 fetchCalls 里就只剩埋点那一次调用，
 * 断言不会被噪声干扰。
 *
 * 返回 fetchCalls 供断言 headers。
 */
function withBrowserEnv(
  cookie: string,
  fn: (fetchCalls: Array<{ url: string; init: RequestInit }>) => Promise<void> | void,
): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const snapshot = {
    window: g.window,
    document: g.document,
    localStorage: g.localStorage,
    fetch: g.fetch,
    hadWindow: "window" in g,
    hadDocument: "document" in g,
    hadLocalStorage: "localStorage" in g,
    hadFetch: "fetch" in g,
  };

  const store = new Map<string, string>();
  // 预置有效 token：exp 设到 1 小时后（isTokenValid 留了 60s 缓冲）
  store.set("dc_token", "test-token");
  store.set("dc_token_exp", String(Math.floor(Date.now() / 1000) + 3600));

  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];

  g.window = {};
  g.document = {
    get cookie(): string {
      return cookie;
    },
  };
  g.localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  g.fetch = async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ code: 0, data: {} }) };
  };

  const restore = () => {
    if (snapshot.hadWindow) g.window = snapshot.window;
    else delete g.window;
    if (snapshot.hadDocument) g.document = snapshot.document;
    else delete g.document;
    if (snapshot.hadLocalStorage) g.localStorage = snapshot.localStorage;
    else delete g.localStorage;
    if (snapshot.hadFetch) g.fetch = snapshot.fetch;
    else delete g.fetch;
  };

  return (async () => {
    try {
      await fn(fetchCalls);
    } finally {
      restore();
    }
  })();
}

const TOKEN = "AbC-123_xyz";
const COOKIE_WITH_TOKEN = `other=1; ${CSRF_COOKIE_NAME}=${TOKEN}; third=2`;

// ============== 第 1 层：lib/csrf.ts 单元测试 ==============

test("readCookie: 从 document.cookie 中取出指定 cookie", () => {
  withCookie(COOKIE_WITH_TOKEN, () => {
    assert.equal(readCookie(CSRF_COOKIE_NAME), TOKEN);
  });
});

test("readCookie: cookie 不存在时返回 null", () => {
  withCookie("other=1", () => {
    assert.equal(readCookie(CSRF_COOKIE_NAME), null);
  });
});

test("readCookie: cookie 名是前缀时不应误匹配", () => {
  // 防止 `XSRF-TOKEN-EVIL=...` 被 startsWith("XSRF-TOKEN=") 命中
  withCookie("XSRF-TOKEN-EVIL=hijack", () => {
    assert.equal(
      readCookie(CSRF_COOKIE_NAME),
      null,
      "必须精确匹配 `<name>=`，不能被前缀cookie 误匹配",
    );
  });
});

test("readCookie: SSR（无 document）返回 null 而不是抛错", () => {
  withoutDocument(() => {
    assert.equal(readCookie(CSRF_COOKIE_NAME), null);
  });
});

test("readCookie: 值经过 URL 解码（后端 gin 用 url.QueryEscape 写入）", () => {
  const raw = "a+b/c=d";
  withCookie(`${CSRF_COOKIE_NAME}=${encodeURIComponent(raw)}`, () => {
    assert.equal(readCookie(CSRF_COOKIE_NAME), raw);
  });
});

test("isStateChanging: 与后端豁免逻辑对齐（GET/HEAD/OPTIONS 豁免）", () => {
  assert.equal(isStateChanging("GET"), false);
  assert.equal(isStateChanging("HEAD"), false);
  assert.equal(isStateChanging("OPTIONS"), false);
  assert.equal(isStateChanging("POST"), true);
  assert.equal(isStateChanging("PUT"), true);
  assert.equal(isStateChanging("DELETE"), true);
  assert.equal(isStateChanging("PATCH"), true);
  // 小写也要能识别（fetch 允许 method: "post"）
  assert.equal(isStateChanging("post"), true);
  assert.equal(isStateChanging("get"), false);
});

test("csrfHeaders: 非幂等方法带上 X-XSRF-TOKEN", () => {
  withCookie(COOKIE_WITH_TOKEN, () => {
    const h = csrfHeaders("POST");
    assert.equal(h[CSRF_HEADER_NAME], TOKEN);
    assert.equal(Object.keys(h).length, 1, "不应带多余 header");
  });
});

test("csrfHeaders: 幂等方法不附加 header", () => {
  withCookie(COOKIE_WITH_TOKEN, () => {
    assert.deepEqual(csrfHeaders("GET"), {});
    assert.deepEqual(csrfHeaders("OPTIONS"), {});
  });
});

test("csrfHeaders: 读不到 cookie 时返回空对象（让后端显式 403，不静默）", () => {
  withCookie("other=1", () => {
    assert.deepEqual(
      csrfHeaders("POST"),
      {},
      "缺 cookie 时不应伪造 header；应由后端 403 暴露问题",
    );
  });
});

// ============== 第 2 层：defaultDeps 生产 fetcher 集成测试 ==============

test("defaultDeps().fetcher: 埋点 POST 必须带 X-XSRF-TOKEN（本次事故的直接护栏）", async () => {
  await withBrowserEnv(COOKIE_WITH_TOKEN, async (fetchCalls) => {
    const { defaultDeps } = await import("./transport.ts");
    const res = await defaultDeps().fetcher(
      "http://localhost:8080/api/v1/courtrooms/sess-1/events",
      { session_uuid: "sess-1", event_type: "fe.trial_started" },
      { "Content-Type": "application/json" },
    );

    assert.equal(res.status, 200);
    assert.equal(fetchCalls.length, 1, "预置有效 token 时只应有一次埋点请求");

    const headers = fetchCalls[0].init.headers as Record<string, string>;
    assert.equal(
      headers[CSRF_HEADER_NAME],
      TOKEN,
      "埋点 fetcher 漏带 CSRF header → 后端 CSRF_TOKEN_MISMATCH 403",
    );
    // 同时不能丢掉 v0.10.1 修好的鉴权头
    assert.equal(headers["Authorization"], "Bearer test-token");
    assert.equal(headers["Content-Type"], "application/json");
  });
});

test("defaultDeps().fetcher: 无 CSRF cookie 时不带该 header（保持显式失败）", async () => {
  await withBrowserEnv("other=1", async (fetchCalls) => {
    const { defaultDeps } = await import("./transport.ts");
    await defaultDeps().fetcher(
      "http://localhost:8080/api/v1/courtrooms/sess-1/events",
      { session_uuid: "sess-1", event_type: "fe.trial_started" },
      {},
    );

    const headers = fetchCalls[0].init.headers as Record<string, string>;
    assert.equal(
      headers[CSRF_HEADER_NAME],
      undefined,
      "读不到 cookie 时不应注入空的 CSRF header",
    );
    assert.equal(headers["Authorization"], "Bearer test-token");
  });
});

test("defaultDeps().fetcher: SSR（无 window）不发请求", async () => {
  const g = globalThis as Record<string, unknown>;
  const hadWindow = "window" in g;
  const prevWindow = g.window;
  const hadFetch = "fetch" in g;
  const prevFetch = g.fetch;
  let called = 0;
  delete g.window;
  g.fetch = async () => {
    called++;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  try {
    const { defaultDeps } = await import("./transport.ts");
    const res = await defaultDeps().fetcher("http://x/y", {}, {});
    assert.equal(called, 0, "SSR 阶段必须 noop");
    assert.equal(res.ok, true);
  } finally {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
    if (hadFetch) g.fetch = prevFetch;
    else delete g.fetch;
  }
});
