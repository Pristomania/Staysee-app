import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION,
  MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
  buildMemoryV3DialogueExtractorRequest,
} from "./dialogueExtractorPrompt.ts";
import { buildMemoryV3LifecycleExtractorRequest } from "./lifecycleExtractorPrompt.ts";

function dialogue() {
  return {
    caseId: "memory-v3-shadow:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    messages: [{
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      role: "user",
      text: "Запомни здесь: мы снова помирились",
      createdAt: "2026-09-28T10:00:00.000Z",
    }],
  };
}

describe("Memory V3 dialogue extractor prompt", () => {
  it("has a fixed scope identity and policy", () => {
    assert.equal(
      MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
      "memory-v3-openrouter-gemini-3.7-flash-dialogue-extractor-v1",
    );
    assert.match(MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION, /same conversation continues/i);
    assert.match(
      MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION,
      /events, decisions, conflict history, and bounded narrative context/i,
    );
  });

  it("is distinct from the lifecycle instruction", () => {
    const dialogueRequest = buildMemoryV3DialogueExtractorRequest(dialogue());
    const lifecycleRequest = buildMemoryV3LifecycleExtractorRequest(dialogue());
    assert.notEqual(dialogueRequest.system, lifecycleRequest.system);
  });
});
