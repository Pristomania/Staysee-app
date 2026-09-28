import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sendMemoryV3StaleAlertSafely } from "./staleAlert.ts";

const BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd12345";
const CHAT_ID = "123456789";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

interface FetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

function harness(overrides: Record<string, unknown> = {}) {
  const fetchCalls: FetchCall[] = [];
  const options = {
    botToken: BOT_TOKEN,
    chatId: CHAT_ID,
    row: {
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      scope: "dialogue",
      newMessageCount: 27,
    },
    fetchImpl: async (url: string, init: FetchCall["init"]) => {
      fetchCalls.push({ url, init });
      return { ok: true };
    },
    ...overrides,
  };
  return { options, fetchCalls };
}

describe("Memory V3 stale-conversation Telegram alert", () => {
  it("sends one privacy-safe alert naming only scope and count", async () => {
    const { options, fetchCalls } = harness();
    const result = await sendMemoryV3StaleAlertSafely(options as never);

    assert.equal(result, undefined);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    assert.equal(fetchCalls[0].init.method, "POST");
    assert.equal(fetchCalls[0].init.headers?.["content-type"], "application/json");
    const body = JSON.parse(fetchCalls[0].init.body ?? "null");
    assert.deepEqual(Object.keys(body).sort(), ["chat_id", "text"]);
    assert.equal(body.chat_id, CHAT_ID);
    assert.match(body.text, /StaySEE Memory V3 — тишина/u);
    assert.match(body.text, /по диалогу/u);
    assert.match(body.text, /27/u);
    for (const forbidden of [USER_ID, CONVERSATION_ID, BOT_TOKEN]) {
      assert.equal(body.text.includes(forbidden), false);
    }
  });

  it("labels lifecycle scope distinctly from dialogue scope", async () => {
    const { options, fetchCalls } = harness({
      row: { userId: USER_ID, conversationId: CONVERSATION_ID, scope: "lifecycle", newMessageCount: 40 },
    });
    await sendMemoryV3StaleAlertSafely(options as never);
    const body = JSON.parse(fetchCalls[0].init.body ?? "null");
    assert.match(body.text, /сквозная/u);
    assert.equal(body.text.includes("по диалогу"), false);
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
      const { options, fetchCalls } = harness(override);
      await sendMemoryV3StaleAlertSafely(options as never);
      assert.deepEqual(fetchCalls, []);
    }
  });

  it("rejects a malformed row without sending", async () => {
    for (const row of [
      { userId: "not-a-uuid", conversationId: CONVERSATION_ID, scope: "dialogue", newMessageCount: 27 },
      { userId: USER_ID, conversationId: "not-a-uuid", scope: "dialogue", newMessageCount: 27 },
      { userId: USER_ID, conversationId: CONVERSATION_ID, scope: "other", newMessageCount: 27 },
      { userId: USER_ID, conversationId: CONVERSATION_ID, scope: "dialogue", newMessageCount: -1 },
      { userId: USER_ID, conversationId: CONVERSATION_ID, scope: "dialogue", newMessageCount: "27" },
      null,
    ]) {
      const { options, fetchCalls } = harness({ row });
      await sendMemoryV3StaleAlertSafely(options as never);
      assert.deepEqual(fetchCalls, []);
    }
  });

  it("swallows a Telegram failure without throwing or retrying", async () => {
    let attempts = 0;
    const { options, fetchCalls } = harness({
      fetchImpl: async () => {
        attempts += 1;
        throw new Error(`RAW_FETCH_SENTINEL ${BOT_TOKEN}`);
      },
    });
    await assert.doesNotReject(() => sendMemoryV3StaleAlertSafely(options as never));
    assert.equal(attempts, 1);
    assert.deepEqual(fetchCalls, []);
  });
});
