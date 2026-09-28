import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION,
  MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION,
  buildMemoryV3LifecycleExtractorRequest,
} from "./lifecycleExtractorPrompt.ts";

function dialogue() {
  return {
    caseId: "memory-v3-shadow:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    messages: [{
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      role: "user",
      text: "У меня есть сын",
      createdAt: "2026-09-28T10:00:00.000Z",
    }],
  };
}

describe("Memory V3 lifecycle extractor prompt", () => {
  it("has a fixed scope identity and policy", () => {
    assert.equal(
      MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION,
      "memory-v3-openrouter-gemini-3.7-flash-lifecycle-extractor-v1",
    );
    assert.match(MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION, /one short atomic cross-conversation fact/i);
    assert.match(
      MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION,
      /omit event chronology, conflict history, health, medical information, personal therapy, religion, and third-party plans/i,
    );
    assert.match(MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION, /"запомни здесь".*conversation-only.*omit/is);
  });

  it("always uses the lifecycle instruction", () => {
    const request = buildMemoryV3LifecycleExtractorRequest(dialogue());
    assert.equal(request.system, MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION);
    assert.equal("scope" in request, false);
    assert.equal("scope" in request.input, false);
  });
});
