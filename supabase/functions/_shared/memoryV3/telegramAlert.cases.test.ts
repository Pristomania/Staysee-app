import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sendMemoryV3TelegramAlertSafely } from "./telegramAlert.ts";

const BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd12345";
const CHAT_ID = "123456789";

interface FetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

function harness(overrides: Record<string, unknown> = {}) {
  const reserved: string[] = [];
  const fetchCalls: FetchCall[] = [];
  const options = {
    botToken: BOT_TOKEN,
    chatId: CHAT_ID,
    path: "read",
    diagnosticCode: "load_failed",
    reserveAlertKey: async (key: string) => {
      reserved.push(key);
      return true;
    },
    fetchImpl: async (url: string, init: FetchCall["init"]) => {
      fetchCalls.push({ url, init });
      return { ok: true };
    },
    ...overrides,
  };
  return { options, reserved, fetchCalls };
}

describe("Memory V3 Telegram alert boundary", () => {
  it("reserves and sends one fixed privacy-safe alert", async () => {
    const { options, reserved, fetchCalls } = harness();
    const result = await sendMemoryV3TelegramAlertSafely(options as never);

    assert.equal(result, undefined);
    assert.deepEqual(reserved, ["read:load_failed"]);
    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0].url,
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    );
    assert.equal(fetchCalls[0].init.method, "POST");
    assert.equal(fetchCalls[0].init.headers?.["content-type"], "application/json");
    const body = JSON.parse(fetchCalls[0].init.body ?? "null");
    assert.deepEqual(Object.keys(body).sort(), ["chat_id", "text"]);
    assert.equal(body.chat_id, CHAT_ID);
    assert.match(
      body.text,
      /^⚠️ StaySEE Memory V3\nPath: read\nCode: load_failed\nTime: \d{4}-\d{2}-\d{2}T/u,
    );
    for (const forbidden of [
      "11111111-1111-4111-8111-111111111111",
      "RAW_DIALOGUE_SENTINEL",
      "RAW_MEMORY_SENTINEL",
      BOT_TOKEN,
      CHAT_ID,
    ]) {
      assert.equal(body.text.includes(forbidden), false);
    }
  });

  it("suppresses a duplicate before Telegram", async () => {
    const { options, reserved, fetchCalls } = harness({
      reserveAlertKey: async (key: string) => {
        reserved.push(key);
        return false;
      },
    });
    await sendMemoryV3TelegramAlertSafely(options as never);
    assert.deepEqual(reserved, ["read:load_failed"]);
    assert.deepEqual(fetchCalls, []);
  });

  it("does nothing when Telegram secrets are absent or malformed", async () => {
    for (const override of [
      { botToken: undefined },
      { botToken: "" },
      { botToken: "not-a-token" },
      { chatId: undefined },
      { chatId: "" },
      { chatId: "owner@example.test" },
    ]) {
      const { options, reserved, fetchCalls } = harness(override);
      await sendMemoryV3TelegramAlertSafely(options as never);
      assert.deepEqual(reserved, []);
      assert.deepEqual(fetchCalls, []);
    }
  });

  it("accepts only closed path and diagnostic combinations", async () => {
    const valid = [
      ["read", "invalid_shape"],
      ["read", "too_large"],
      ["write", "invalid_source"],
      ["write", "state_write_failed"],
      ["write", "unknown_failure"],
    ];
    for (const [path, diagnosticCode] of valid) {
      const { options, reserved, fetchCalls } = harness({ path, diagnosticCode });
      await sendMemoryV3TelegramAlertSafely(options as never);
      assert.deepEqual(reserved, [`${path}:${diagnosticCode}`]);
      assert.equal(fetchCalls.length, 1);
    }

    for (const override of [
      { path: "reader" },
      { path: "read", diagnosticCode: "state_write_failed" },
      { path: "write", diagnosticCode: "load_failed" },
      { path: "write", diagnosticCode: "RAW_SENTINEL" },
    ]) {
      const { options, reserved, fetchCalls } = harness(override);
      await sendMemoryV3TelegramAlertSafely(options as never);
      assert.deepEqual(reserved, []);
      assert.deepEqual(fetchCalls, []);
    }
  });

  it("never executes accessors or leaks hostile option failures", async () => {
    let getterCalls = 0;
    const { options, reserved, fetchCalls } = harness();
    Object.defineProperty(options, "diagnosticCode", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("RAW_GETTER_SENTINEL");
      },
    });
    await assert.doesNotReject(() =>
      sendMemoryV3TelegramAlertSafely(options as never)
    );
    assert.equal(getterCalls, 0);
    assert.deepEqual(reserved, []);
    assert.deepEqual(fetchCalls, []);

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    await assert.doesNotReject(() =>
      sendMemoryV3TelegramAlertSafely(proxy as never)
    );
  });

  it("swallows reservation and Telegram failures without retry or logging secrets", async () => {
    const originalError = console.error;
    const originalLog = console.log;
    const logs: string[] = [];
    console.error = (...values: unknown[]) => logs.push(values.join(" "));
    console.log = (...values: unknown[]) => logs.push(values.join(" "));
    try {
      const reserveFailure = harness({
        reserveAlertKey: async () => {
          throw new Error(`RAW_RESERVE_SENTINEL ${BOT_TOKEN}`);
        },
      });
      await assert.doesNotReject(() =>
        sendMemoryV3TelegramAlertSafely(reserveFailure.options as never)
      );
      assert.deepEqual(reserveFailure.fetchCalls, []);

      let attempts = 0;
      const fetchFailure = harness({
        fetchImpl: async () => {
          attempts += 1;
          throw new Error(`RAW_FETCH_SENTINEL ${BOT_TOKEN}`);
        },
      });
      await assert.doesNotReject(() =>
        sendMemoryV3TelegramAlertSafely(fetchFailure.options as never)
      );
      assert.equal(attempts, 1);

      const nonOk = harness({
        fetchImpl: async () => ({ ok: false }),
      });
      await assert.doesNotReject(() =>
        sendMemoryV3TelegramAlertSafely(nonOk.options as never)
      );
      assert.equal(logs.length, 0);
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
  });
});
