import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION } from "./dialogueExtractorPrompt.ts";
import { MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION } from "./lifecycleExtractorPrompt.ts";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const fixtures = [
  { source: "Сын съехал и может уйти в армию", lifecycle: "Есть сын", dialogue: "may retain move and army context" },
  { source: "С Димой дважды расходились, сейчас вместе", lifecycle: "Состоит в отношениях с Димой", dialogue: "may retain breakup history" },
  { source: "Живет одна в доме площадью 100 м²", lifecycle: "Живет одна", dialogue: "may retain property detail when relevant" },
  { source: "Не употребляет алкоголь из-за страха за здоровье", lifecycle: "omit", dialogue: "may retain locally when relevant and safe" },
  { source: "Проходила личную и групповую терапию и училась консультированию", lifecycle: "omit personal therapy; separately evidenced professional role only", dialogue: "may retain therapy context when relevant and safe" },
  { source: "Запомни здесь: у меня есть сын", lifecycle: "omit because conversation-only", dialogue: "admit" },
  { source: "Запомни: у меня есть сын", lifecycle: "Есть сын", dialogue: "may also retain locally" },
] as const;

describe("Memory V3 scope extractor semantic fixtures", () => {
  for (const fixture of fixtures) {
    it(`embeds both scope decisions for: ${fixture.source}`, () => {
      assert.match(MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION, new RegExp(escapeRegExp(fixture.source), "u"));
      assert.match(MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION, new RegExp(escapeRegExp(fixture.lifecycle), "u"));
      assert.match(MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION, new RegExp(escapeRegExp(fixture.source), "u"));
      assert.match(MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION, new RegExp(escapeRegExp(fixture.dialogue), "u"));
    });
  }
});
