import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { waitForUserMessageSaved } from "./turnMessageWait.ts";

// The website asks the chat for a reply first and saves the turn's messages afterwards. The background memory
// run starts as soon as the reply is ready, so for the first message of a conversation it could read the
// conversation before the message was saved, find nothing, and fail with invalid_source (an alert, no run).
// The run now waits (briefly) until the message it is about to read exists.

const NOW = Date.parse("2026-10-20T18:00:00.000Z");
const row = (content: string, secondsAgo = 0) => ({ content, created_at: new Date(NOW - secondsAgo * 1000).toISOString() });

function clock() {
  let now = NOW;
  const sleeps: number[] = [];
  return { sleeps, now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
}

describe("waiting for the turn's message to be saved", () => {
  it("returns at once, without sleeping, when the message is already saved", async () => {
    const c = clock();
    const found = await waitForUserMessageSaved({
      load: async () => [row("Привет, это я")],
      text: "Привет, это я", sinceMs: NOW - 1_000, now: c.now, sleep: c.sleep,
    });
    assert.equal(found, true);
    assert.deepEqual(c.sleeps, []);
  });

  it("waits and looks again until the message appears", async () => {
    const c = clock();
    let calls = 0;
    const found = await waitForUserMessageSaved({
      load: async () => { calls += 1; return calls < 4 ? [] : [row("Привет, это я")]; },
      text: "Привет, это я", sinceMs: NOW - 1_000, now: c.now, sleep: c.sleep, intervalMs: 500,
    });
    assert.equal(found, true);
    assert.equal(calls, 4);
    assert.deepEqual(c.sleeps, [500, 500, 500]);
  });

  it("gives up after the time limit and lets the run go on, so a message that never arrives cannot hold it", async () => {
    const c = clock();
    const found = await waitForUserMessageSaved({
      load: async () => [], text: "Привет", sinceMs: NOW - 1_000, now: c.now, sleep: c.sleep,
      timeoutMs: 2_000, intervalMs: 500,
    });
    assert.equal(found, false);
    assert.equal(c.sleeps.reduce((sum, ms) => sum + ms, 0) <= 2_500, true);
  });

  it("does not take an older identical message for the new one", async () => {
    const c = clock();
    const found = await waitForUserMessageSaved({
      load: async () => [row("Спасибо", 600)], text: "Спасибо", sinceMs: NOW - 1_000, now: c.now, sleep: c.sleep,
      timeoutMs: 1_000, intervalMs: 500,
    });
    assert.equal(found, false);
  });

  it("ignores blanks around the text, as the website trims what it sends", async () => {
    const c = clock();
    const found = await waitForUserMessageSaved({
      load: async () => [row("Привет")], text: "  Привет \n", sinceMs: NOW - 1_000, now: c.now, sleep: c.sleep,
    });
    assert.equal(found, true);
  });

  it("never throws: a failing lookup just means it stops waiting", async () => {
    const c = clock();
    const found = await waitForUserMessageSaved({
      load: async () => { throw new Error("database down"); }, text: "Привет", sinceMs: NOW - 1_000, now: c.now, sleep: c.sleep,
    });
    assert.equal(found, false);
  });
});

describe("the chat function waits before starting the memory runs", () => {
  const chat = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8");

  it("waits for the saved message at the start of the background memory work, not before the reply", () => {
    const wait = chat.indexOf("waitForUserMessageSaved(");
    assert.ok(wait > 0, "the wait is missing");
    const memoryStart = chat.indexOf("const memoryV3ShadowPromise");
    assert.ok(memoryStart > 0);
    assert.ok(wait > memoryStart, "must be inside the background memory work");
    assert.ok(wait < chat.indexOf("const dialogueEligibility = resolveMemoryV3DialogueEligibility"), "before the runs are decided and started");
  });
});
