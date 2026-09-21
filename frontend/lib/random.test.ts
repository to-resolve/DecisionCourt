// lib/random.ts 测试
//
// 回归目标（2026-09-21 线上事故）：`crypto.randomUUID()` 要求安全上下文，
// 本项目按「公网 IP + 端口」部署（http://<IP>:8080，非 HTTPS 非 localhost）
// 时它为 undefined，直接调用会抛 TypeError，导致：
//   1. 点「开庭」请求发不出去（CourtroomScene 的 Idempotency-Key）
//   2. 匿名身份退化成固定串 "anon_placeholder"（所有访客共用数据）
// uuid() 必须在没有 randomUUID 的环境下依然返回合法 v4 UUID。

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import { uuid } from "./random.ts";

// RFC 4122 v4：版本位 = 4，变体位 = [89ab]
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * withCrypto: 在指定的全局 crypto 实现下执行 fn，结束后原样恢复。
 *
 * `mode`:
 *   - "no-randomUUID"：有 getRandomValues 但没有 randomUUID
 *                      —— **真实模拟非安全上下文（HTTP + 非 localhost）**
 *   - "none"          ：完全没有 crypto —— 极端兜底分支
 */
function withCrypto<T>(mode: "no-randomUUID" | "none", fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");

  if (mode === "none") {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });
  } else {
    // 关键：只提供 getRandomValues。它**不要求安全上下文**，是真实的降级路径。
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues: <T extends ArrayBufferView | null>(arr: T): T => {
          if (arr) randomFillSync(arr as unknown as NodeJS.ArrayBufferView);
          return arr;
        },
      },
    });
  }

  try {
    return fn();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "crypto", original);
    } else {
      delete (globalThis as { crypto?: unknown }).crypto;
    }
  }
}

test("uuid: 默认环境返回合法 v4 UUID", () => {
  const v = uuid();
  assert.equal(typeof v, "string");
  assert.equal(v.length, 36);
  assert.match(v, V4);
});

test("uuid: 无 randomUUID（非安全上下文）不抛异常且返回合法 v4", () => {
  const v = withCrypto("no-randomUUID", () => uuid());
  assert.match(v, V4, `非安全上下文下应仍返回合法 v4 UUID，实际: ${v}`);
});

test("uuid: 完全没有 crypto 时仍返回合法 v4（极端兜底分支）", () => {
  const v = withCrypto("none", () => uuid());
  assert.match(v, V4);
});

test("uuid: 非安全上下文下大量调用不重复", () => {
  const seen = new Set<string>();
  const N = 2000;
  withCrypto("no-randomUUID", () => {
    for (let i = 0; i < N; i++) seen.add(uuid());
  });
  assert.equal(seen.size, N, `应产生 ${N} 个互不相同的 UUID，实际 ${seen.size} 个`);
});

test("uuid: v4 版本位与变体位正确（非安全上下文）", () => {
  withCrypto("no-randomUUID", () => {
    for (let i = 0; i < 200; i++) {
      const v = uuid();
      assert.equal(v[14], "4", `第 15 位应为版本号 4: ${v}`);
      assert.ok(
        "89ab".includes(v[19]),
        `第 20 位应为变体 [89ab]: ${v}`,
      );
    }
  });
});
