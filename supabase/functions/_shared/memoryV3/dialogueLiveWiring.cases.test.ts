import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const INDEX_URL = new URL("../../staysee-chat/index.ts", import.meta.url);

function indexSource(): string {
  return readFileSync(INDEX_URL, "utf8");
}

describe("Memory V3 dialogue live wiring", () => {
  it("schedules dialogue and lifecycle memory independently", () => {
    const source = indexSource();
    const writeBlockStart = source.indexOf("const memoryV3ShadowPromise");
    assert.ok(writeBlockStart >= 0, "write block must exist");
    const writeBlockEnd = source.indexOf("EdgeRuntime.waitUntil(", writeBlockStart);
    assert.ok(writeBlockEnd > writeBlockStart, "write block must be bounded");
    const block = source.slice(writeBlockStart, writeBlockEnd);
    assert.match(block, /resolveMemoryV3DialogueEligibility/);
    assert.match(block, /runMemoryV3DialogueShadowBackgroundSafely/);
    assert.match(block, /runMemoryV3DialogueShadow\(/);
    assert.match(block, /const dialogueMemoryPromise/);
    assert.match(block, /const lifecycleMemoryPromise/);
    assert.match(block, /Promise\.all\(\[dialogueMemoryPromise, lifecycleMemoryPromise\]\)/);
    assert.doesNotMatch(
      block,
      /if \(dialogueEligibility\.eligible\) \{\s*return runMemoryV3DialogueShadowBackgroundSafely/s,
    );
  });

  it("loads dialogue memory additively, independent of the lifecycle read gate", () => {
    const source = indexSource();
    assert.match(source, /resolveMemoryV3DialogueEligibility/);
    assert.match(source, /createMemoryV3DialogueReadStore/);
    assert.match(source, /dialogueMemory\s*!==\s*undefined/);
    // Additive: the dialogue-read check must not be nested inside the
    // lifecycle-read eligibility block (which would make it conditional on
    // the legacy system remaining enabled).
    const lifecycleReadIfStart = source.indexOf("if (lifecycleReadEligibility.eligible) {");
    const lifecycleReadIfEnd = source.indexOf("Additive, independent of the legacy lifecycle read", lifecycleReadIfStart);
    assert.ok(lifecycleReadIfStart >= 0 && lifecycleReadIfEnd > lifecycleReadIfStart);
    const lifecycleReadBlock = source.slice(lifecycleReadIfStart, lifecycleReadIfEnd);
    assert.equal(lifecycleReadBlock.includes("resolveMemoryV3DialogueEligibility"), false);
  });

  it("shares the same canary env var pair between the write and read paths", () => {
    const source = indexSource();
    assert.equal(
      (source.match(/STAYSEE_MEMORY_V3_DIALOGUE_MODE/g) ?? []).length,
      2,
      "one write-path lookup and one read-path lookup",
    );
    assert.equal(
      (source.match(/STAYSEE_MEMORY_V3_DIALOGUE_ALLOWED_USER_ID/g) ?? []).length,
      2,
    );
  });

  it("never hardcodes a canary account id in source", () => {
    const source = indexSource();
    const dialogueBlockStart = source.indexOf("resolveMemoryV3DialogueEligibility");
    const nearby = source.slice(dialogueBlockStart, dialogueBlockStart + 400);
    assert.doesNotMatch(nearby, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});
