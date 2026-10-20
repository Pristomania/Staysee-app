import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { isLegacySummaryDisabled, withoutLegacySummary } from "./legacySummaryMode.ts";

const USER = "5349a89a-4cc5-4338-b841-8a5723c95d8f";
const OTHER = "11111111-1111-4111-8111-111111111111";

describe("legacy conversation summary switch", () => {
  it("is ON (nothing disabled) when the setting is missing or blank", () => {
    for (const raw of [undefined, null, "", "   "]) {
      assert.equal(isLegacySummaryDisabled(USER, raw), false);
    }
  });

  it("'all' turns it off for every account", () => {
    assert.equal(isLegacySummaryDisabled(USER, "all"), true);
    assert.equal(isLegacySummaryDisabled(OTHER, " ALL "), true);
  });

  it("a list turns it off only for the listed accounts", () => {
    const raw = `${OTHER}, ${USER.toUpperCase()}`;
    assert.equal(isLegacySummaryDisabled(USER, raw), true);
    assert.equal(isLegacySummaryDisabled(OTHER, raw), true);
    assert.equal(isLegacySummaryDisabled("22222222-2222-4222-8222-222222222222", raw), false);
  });

  it("never disables by accident: junk, look-alikes and a missing user id keep it ON", () => {
    for (const raw of ["true", "yes", "1", "off", "allx", "not-a-uuid", `${USER.slice(0, 20)}`, `${USER}x`]) {
      assert.equal(isLegacySummaryDisabled(USER, raw), false, raw);
    }
    assert.equal(isLegacySummaryDisabled("", "all"), false, "no verified user, nothing to decide");
    assert.equal(isLegacySummaryDisabled(USER, `junk,${USER}`), true, "a bad entry does not spoil a good one");
  });
});

describe("hiding the legacy summary from a context packet", () => {
  const packet = {
    conversationMeta: {
      id: "c1", title: "Моя беседа", metadata: { keep: true },
      conversation_summary: '{"people":["Аня"]}', summary: "старый текст", emotional_tone: "тревожная",
      summary_updated_at: "2026-10-18T10:00:00Z", last_message_at: "2026-10-18T10:00:00Z",
    },
    corrections: ["клуб я сама придумала"],
    durableCorrections: [{ id: "d1" }],
    recentMessages: [{ role: "user", content: "привет" }],
    messagesSinceSummary: 3,
  };

  it("removes the summary, its tone, its timestamp and the phrase-catcher corrections", () => {
    const hidden = withoutLegacySummary(packet);
    assert.equal(hidden.conversationMeta!.conversation_summary, null);
    assert.equal(hidden.conversationMeta!.summary, null);
    assert.equal(hidden.conversationMeta!.emotional_tone, null);
    assert.equal(hidden.conversationMeta!.summary_updated_at, null);
    assert.deepEqual(hidden.corrections, []);
  });

  it("keeps everything else untouched: title, metadata, messages, durable corrections", () => {
    const hidden = withoutLegacySummary(packet);
    assert.equal(hidden.conversationMeta!.title, "Моя беседа");
    assert.deepEqual(hidden.conversationMeta!.metadata, { keep: true });
    assert.equal(hidden.conversationMeta!.last_message_at, "2026-10-18T10:00:00Z");
    assert.deepEqual(hidden.recentMessages, packet.recentMessages);
    assert.deepEqual(hidden.durableCorrections, packet.durableCorrections);
    assert.equal(hidden.messagesSinceSummary, 3);
  });

  it("does not modify the original packet", () => {
    const before = JSON.stringify(packet);
    withoutLegacySummary(packet);
    assert.equal(JSON.stringify(packet), before);
  });

  it("copes with a conversation that has no metadata", () => {
    const hidden = withoutLegacySummary({ ...packet, conversationMeta: null });
    assert.equal(hidden.conversationMeta, null);
    assert.deepEqual(hidden.corrections, []);
  });
});

describe("the chat function honours the switch everywhere the legacy summary is used", () => {
  const source = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8");

  it("decides once, from the verified user and the environment, with ON as the default", () => {
    assert.match(source, /isLegacySummaryDisabled\(\s*userId,\s*Deno\.env\.get\("STAYSEE_LEGACY_SUMMARY_OFF"\)/);
  });

  it("hides the summary from the context before anything reads it", () => {
    assert.match(source, /legacySummaryOff\s*\?\s*withoutLegacySummary\(/);
  });

  it("skips the refresh before the reply (eager) and in the background after it", () => {
    assert.match(source, /!legacySummaryOff\s*&&\s*shouldEagerRefreshSummary\(/);
    assert.match(source, /!legacySummaryOff\s*&&\s*conversationId\s*&&\s*packetForSummary/);
  });
});
