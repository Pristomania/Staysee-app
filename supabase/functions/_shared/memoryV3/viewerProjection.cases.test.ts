import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectMemoryV3ViewerItems } from "./viewerProjection.ts";

describe("Memory V3 viewer projection", () => {
  it("keeps only event and recurrence kinds, dropping hypotheses", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null },
      { memoryKey: "b", kind: "hypothesis", claim: "Y", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null },
      { memoryKey: "c", kind: "recurrence", claim: "Z", sensitivity: "sensitive", eventTimeStart: null, eventTimeEnd: null },
    ]);
    assert.deepEqual(result, [
      { memoryKey: "a", kind: "event", claim: "X", eventTimeStart: null, eventTimeEnd: null, sensitivity: "normal" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", eventTimeStart: null, eventTimeEnd: null, sensitivity: "sensitive" },
    ]);
  });

  it("passes through dates and keeps the field set exact", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: "2026-01-01", eventTimeEnd: "2026-01-31" },
    ]);
    assert.deepEqual(Object.keys(result[0]).sort(), [
      "claim", "eventTimeEnd", "eventTimeStart", "kind", "memoryKey", "sensitivity",
    ]);
    assert.equal(result[0].eventTimeStart, "2026-01-01");
    assert.equal(result[0].eventTimeEnd, "2026-01-31");
  });

  it("returns an empty array for an empty or all-hypothesis input", () => {
    assert.deepEqual(projectMemoryV3ViewerItems([]), []);
    assert.deepEqual(projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "hypothesis", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null },
    ]), []);
  });
});
