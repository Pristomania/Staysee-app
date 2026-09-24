import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SOURCE_URL = new URL("../../../../src/lib/memoryV3Viewer.ts", import.meta.url);

function source(): string {
  return readFileSync(SOURCE_URL, "utf8");
}

describe("memoryV3Viewer delete-all client", () => {
  it("exposes deleteAllMemoryV3Data as two separate scoped calls, not one combined wipe", () => {
    const text = source();
    assert.match(text, /export async function deleteAllMemoryV3Data/);
    assert.match(text, /scope: 'account_wide' \| 'dialogue'/);
    assert.match(text, /action: 'delete_all'/);
    assert.doesNotMatch(text, /action: 'delete_all_everything'/);
  });
});
