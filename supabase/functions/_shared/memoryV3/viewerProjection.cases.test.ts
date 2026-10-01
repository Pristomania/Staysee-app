import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectMemoryV3ViewerItems, projectMemoryV3ExportItems } from "./viewerProjection.ts";

describe("Memory V3 viewer projection", () => {
  it("keeps only event and recurrence kinds, dropping hypotheses", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      { memoryKey: "b", kind: "hypothesis", claim: "Y", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Z" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", sensitivity: "sensitive", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.deepEqual(result, [
      { memoryKey: "a", kind: "event", claim: "X", eventTimeStart: null, eventTimeEnd: null, sensitivity: "normal", topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", eventTimeStart: null, eventTimeEnd: null, sensitivity: "sensitive", topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
    ]);
  });

  it("passes through dates and keeps the field set exact", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: "2026-01-01", eventTimeEnd: "2026-01-31", topic: "life_context", firstSeenAt: "2026-08-01T00:00:00Z", updatedAt: "2026-09-20T08:00:00Z", alternative: null },
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
      { memoryKey: "a", kind: "hypothesis", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Y" },
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
        { memoryKey: "a", kind: "event", claim: input, sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      ]);
      assert.equal(result.claim, expected, input);
    }
  });

  it("does not touch a claim that never had the word at the start, or one that's just the word alone", () => {
    const untouched = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "Уважает мнение пользователя в группе", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(untouched[0].claim, "Уважает мнение пользователя в группе");

    const wordAlone = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "Пользователь", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(wordAlone[0].claim, "Пользователь");
  });

  it("passes topic through unchanged, including null", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      { memoryKey: "b", kind: "recurrence", claim: "Y", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result[0].topic, "life_context");
    assert.equal(result[1].topic, null);
  });

  it("passes updatedAt through unchanged", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-15T12:30:00Z", alternative: null },
    ]);
    assert.equal(result[0].updatedAt, "2026-03-15T12:30:00Z");
  });

  it("passes firstSeenAt through unchanged, even when it differs from updatedAt", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-01-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result[0].firstSeenAt, "2026-01-01T00:00:00Z");
    assert.equal(result[0].updatedAt, "2026-06-01T00:00:00Z");
  });
});

describe("Memory V3 export projection", () => {
  it("keeps all three kinds, including hypothesis", () => {
    const result = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      { memoryKey: "b", kind: "hypothesis", claim: "Y", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Альтернатива Y" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", sensitivity: "sensitive", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result.length, 3);
    assert.deepEqual(result.map((item) => item.kind).sort(), ["event", "hypothesis", "recurrence"]);
  });

  it("keeps the alternative field for a hypothesis", () => {
    const result = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "hypothesis", claim: "Возможно, часто тревожится перед встречами", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Или просто готовится заранее" },
    ]);
    assert.equal(result[0].alternative, "Или просто готовится заранее");
  });

  it("still strips the leading 'пользователь'/'клиент' word", () => {
    const [result] = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "event", claim: "Пользователь любит утренние прогулки", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result.claim, "Любит утренние прогулки");
  });

  it("keeps the field set exact, including alternative", () => {
    const result = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.deepEqual(Object.keys(result[0]).sort(), [
      "alternative", "claim", "eventTimeEnd", "eventTimeStart", "firstSeenAt", "kind", "memoryKey", "sensitivity", "topic", "updatedAt",
    ]);
  });

  it("returns an empty array for empty input", () => {
    assert.deepEqual(projectMemoryV3ExportItems([]), []);
  });
});
