import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectMemoryV3ViewerItems } from "./viewerProjection.ts";

describe("Memory V3 viewer projection", () => {
  it("keeps only event and recurrence kinds, dropping hypotheses", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", updatedAt: "2026-09-01T00:00:00Z" },
      { memoryKey: "b", kind: "hypothesis", claim: "Y", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, updatedAt: "2026-09-01T00:00:00Z" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", sensitivity: "sensitive", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", updatedAt: "2026-09-01T00:00:00Z" },
    ]);
    assert.deepEqual(result, [
      { memoryKey: "a", kind: "event", claim: "X", eventTimeStart: null, eventTimeEnd: null, sensitivity: "normal", topic: "life_context", updatedAt: "2026-09-01T00:00:00Z" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", eventTimeStart: null, eventTimeEnd: null, sensitivity: "sensitive", topic: "life_context", updatedAt: "2026-09-01T00:00:00Z" },
    ]);
  });

  it("passes through dates and keeps the field set exact", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: "2026-01-01", eventTimeEnd: "2026-01-31", topic: "life_context", updatedAt: "2026-09-20T08:00:00Z" },
    ]);
    assert.deepEqual(Object.keys(result[0]).sort(), [
      "claim", "eventTimeEnd", "eventTimeStart", "kind", "memoryKey", "sensitivity", "topic", "updatedAt",
    ]);
    assert.equal(result[0].eventTimeStart, "2026-01-01");
    assert.equal(result[0].eventTimeEnd, "2026-01-31");
    assert.equal(result[0].updatedAt, "2026-09-20T08:00:00Z");
  });

  it("returns an empty array for an empty or all-hypothesis input", () => {
    assert.deepEqual(projectMemoryV3ViewerItems([]), []);
    assert.deepEqual(projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "hypothesis", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, updatedAt: "2026-09-01T00:00:00Z" },
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
        { memoryKey: "a", kind: "event", claim: input, sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, updatedAt: "2026-09-01T00:00:00Z" },
      ]);
      assert.equal(result.claim, expected, input);
    }
  });

  it("does not touch a claim that never had the word at the start, or one that's just the word alone", () => {
    const untouched = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "Уважает мнение пользователя в группе", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, updatedAt: "2026-09-01T00:00:00Z" },
    ]);
    assert.equal(untouched[0].claim, "Уважает мнение пользователя в группе");

    const wordAlone = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "Пользователь", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, updatedAt: "2026-09-01T00:00:00Z" },
    ]);
    assert.equal(wordAlone[0].claim, "Пользователь");
  });

  it("passes topic through unchanged, including null", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", updatedAt: "2026-09-01T00:00:00Z" },
      { memoryKey: "b", kind: "recurrence", claim: "Y", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, updatedAt: "2026-09-01T00:00:00Z" },
    ]);
    assert.equal(result[0].topic, "life_context");
    assert.equal(result[1].topic, null);
  });

  it("passes updatedAt through unchanged", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, updatedAt: "2026-03-15T12:30:00Z" },
    ]);
    assert.equal(result[0].updatedAt, "2026-03-15T12:30:00Z");
  });
});
