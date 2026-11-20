import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import { polishAssistantOutput, polishMergedReply } from "./mergeContinuation.ts";

// The rule (owner's decision, 20.11.2026): no code decides anything about a reply by the words in it. The reply the model wrote is the
// reply that goes out. What may be said and how is in the text of the prompt (K3 lets Stacy use rough words rarely, and only when the
// person does, and never to demean).
// Before this, a list of words was cut out of every reply: «Чёрт, я сбилась» became «я сбилась», a reply of one such word was replaced
// with a fixed phrase, English «shit/damn/hell» were deleted anywhere, and (by a mistake in the list) ordinary words that start with
// «черт» lost their beginning at the start of a paragraph: «Черты характера» became «ы характера».

const REPLIES = [
  "Чёрт, я сбилась. Давай заново.",
  "Я сбилась.\nЧёрт возьми, это сложно.",
  "Чёрт!",
  "Блин, я перепутала даты.",
  "Хрен с ним, давай дальше.",
  "Oh shit, I was wrong.",
  "It was hell for you.",
  // ordinary words that only start like a listed one
  "Черты характера у тебя сильные.",
  "Это важно.\n\nЧертовски устала, да?",
  "Чертёж плана готов.",
];

describe("a reply goes out exactly as the model wrote it", () => {
  for (const reply of REPLIES) {
    it(`polishAssistantOutput leaves «${reply.replace(/\n/g, " / ")}» alone`, () => {
      assert.equal(polishAssistantOutput(reply), reply);
    });
    it(`polishMergedReply leaves «${reply.replace(/\n/g, " / ")}» alone`, () => {
      assert.equal(polishMergedReply(reply), reply);
    });
  }
});

describe("the word-deleting filter is gone and must not come back", () => {
  it("there is no languageGuard module with a list of words to cut", () => {
    assert.equal(existsSync(new URL("./languageGuard.ts", import.meta.url)), false);
  });
});
