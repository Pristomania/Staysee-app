import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureConversationRevisions } from "./dialogue-history-backfill-revision.ts";

describe("dialogue history backfill revision capture", () => {
  it("calls the reader once per distinct conversation id and preserves each result", async () => {
    const calls: string[] = [];
    const map = await captureConversationRevisions(["x", "y"], async (id) => {
      calls.push(id);
      return id === "x" ? 0 : 7;
    });
    assert.deepEqual(calls, ["x", "y"]);
    assert.equal(map.get("x"), 0);
    assert.equal(map.get("y"), 7);
  });

  it("returns an empty map for an empty conversation id list without calling the reader", async () => {
    let calls = 0;
    const map = await captureConversationRevisions([], async () => {
      calls += 1;
      return 0;
    });
    assert.equal(calls, 0);
    assert.equal(map.size, 0);
  });
});
