import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectMemoryV3ViewerItems, projectMemoryV3ExportItems } from "./viewerProjection.ts";

describe("Memory V3 viewer projection", () => {
  it("keeps only event and recurrence kinds, dropping hypotheses", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      { memoryKey: "b", kind: "hypothesis", claim: "Y", status: "supported", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Z" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", status: "active", sensitivity: "sensitive", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.deepEqual(result, [
      { memoryKey: "a", kind: "event", claim: "X", eventTimeStart: null, eventTimeEnd: null, sensitivity: "normal", topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", eventTimeStart: null, eventTimeEnd: null, sensitivity: "sensitive", topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
    ]);
  });

  it("passes through dates and keeps the field set exact", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", status: "active", sensitivity: "normal", eventTimeStart: "2026-01-01", eventTimeEnd: "2026-01-31", topic: "life_context", firstSeenAt: "2026-08-01T00:00:00Z", updatedAt: "2026-09-20T08:00:00Z", alternative: null },
    ]);
    assert.deepEqual(Object.keys(result[0]).sort(), [
      "claim", "eventTimeEnd", "eventTimeStart", "firstSeenAt", "kind", "memoryKey", "sensitivity", "topic", "updatedAt",
    ]);
    assert.equal(result[0].eventTimeStart, "2026-01-01");
    assert.equal(result[0].eventTimeEnd, "2026-01-31");
    assert.equal(result[0].firstSeenAt, "2026-08-01T00:00:00Z");
    assert.equal(result[0].updatedAt, "2026-09-20T08:00:00Z");
  });

  it("returns an empty array for an empty or all-hypothesis input", () => {
    assert.deepEqual(projectMemoryV3ViewerItems([]), []);
    assert.deepEqual(projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "hypothesis", claim: "X", status: "supported", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Y" },
    ]), []);
  });

  it("strips a leading 'пользователь'/'клиент' from already-stored claims and re-capitalizes", () => {
    const cases: Array<[string, string]> = [
      ["Пользователь любит утренние прогулки", "Любит утренние прогулки"],
      ["пользователь работает удалённо", "Работает удалённо"],
      ["Пользователь: переехала в Казань", "Переехала в Казань"],
      ["Клиент предпочитает переписку", "Предпочитает переписку"],
    ];
    for (const [input, expected] of cases) {
      const [result] = projectMemoryV3ViewerItems([
        { memoryKey: "a", kind: "event", claim: input, status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      ]);
      assert.equal(result.claim, expected, input);
    }
  });

  it("does not touch a claim that never had the word at the start, or one that's just the word alone", () => {
    const untouched = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "Уважает мнение пользователя в группе", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(untouched[0].claim, "Уважает мнение пользователя в группе");

    const wordAlone = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "Пользователь", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(wordAlone[0].claim, "Пользователь");
  });

  it("passes topic through unchanged, including null", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      { memoryKey: "b", kind: "recurrence", claim: "Y", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result[0].topic, "life_context");
    assert.equal(result[1].topic, null);
  });

  it("passes updatedAt through unchanged", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-15T12:30:00Z", alternative: null },
    ]);
    assert.equal(result[0].updatedAt, "2026-03-15T12:30:00Z");
  });

  it("passes firstSeenAt through unchanged, even when it differs from updatedAt", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-01-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result[0].firstSeenAt, "2026-01-01T00:00:00Z");
    assert.equal(result[0].updatedAt, "2026-06-01T00:00:00Z");
  });
});

describe("Memory V3 export projection", () => {
  it("keeps all three kinds, including a supported hypothesis", () => {
    const result = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "event", claim: "X", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      { memoryKey: "b", kind: "hypothesis", claim: "Y", status: "supported", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Альтернатива Y" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", status: "active", sensitivity: "sensitive", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result.length, 3);
    assert.deepEqual(result.map((item) => item.kind).sort(), ["event", "hypothesis", "recurrence"]);
  });

  it("drops a hypothesis the AI itself rejected, discarded as stale, or never confirmed -- never shown to the user as something 'remembered'", () => {
    const result = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "hypothesis", claim: "Rejected", status: "rejected", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Alt" },
      { memoryKey: "b", kind: "hypothesis", claim: "Stale", status: "stale", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Alt" },
      { memoryKey: "c", kind: "hypothesis", claim: "Candidate", status: "candidate", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Alt" },
      { memoryKey: "d", kind: "hypothesis", claim: "Supported", status: "supported", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Alt" },
    ]);
    assert.deepEqual(result.map((item) => item.memoryKey), ["d"]);
  });

  it("never drops an event or recurrence based on status -- only hypothesis status is filtered", () => {
    const result = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "event", claim: "X", status: "rejected", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      { memoryKey: "b", kind: "recurrence", claim: "Y", status: "stale", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result.length, 2);
  });

  it("keeps the alternative field for a hypothesis", () => {
    const result = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "hypothesis", claim: "Возможно, часто тревожится перед встречами", status: "supported", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Или просто готовится заранее" },
    ]);
    assert.equal(result[0].alternative, "Или просто готовится заранее");
  });

  it("still strips the leading 'пользователь'/'клиент' word", () => {
    const [result] = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "event", claim: "Пользователь любит утренние прогулки", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result.claim, "Любит утренние прогулки");
  });

  it("passes conversationId through when the source has one (dialogue items)", () => {
    const [result] = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "event", claim: "X", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null, conversationId: "conv-1" },
    ]);
    assert.equal(result.conversationId, "conv-1");
  });

  it("defaults conversationId to null when the source has none (lifecycle items)", () => {
    const [result] = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "event", claim: "X", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result.conversationId, null);
  });

  it("keeps the field set exact, including alternative and conversationId", () => {
    const result = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "event", claim: "X", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.deepEqual(Object.keys(result[0]).sort(), [
      "alternative", "claim", "conversationId", "eventTimeEnd", "eventTimeStart", "firstSeenAt", "kind", "memoryKey", "sensitivity", "topic", "updatedAt",
    ]);
  });

  it("returns an empty array for empty input", () => {
    assert.deepEqual(projectMemoryV3ExportItems([]), []);
  });
});
