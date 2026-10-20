import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mergeContinuationWithoutOverlap,
  polishMergedReply,
  stripOrphanContinueMarkers,
} from "./mergeContinuation.ts";

// polishMergedReply runs on EVERY reply, not only on ones glued from several segments. Its cleanup of a
// stray «дальше» the model puts between continuation chunks used to delete the ordinary word «дальше»
// (and its period) from normal sentences: «…как двигаться дальше. Но, конечно…» became
// «…как двигаться Но, конечно…», and «Что будет дальше и как…» became «Что будет и как…».
// Seen in a live answer on 2026-10-20.

describe("ordinary use of the word «дальше» survives the reply cleanup", () => {
  it("keeps «дальше» at the end of a sentence, and the sentence break after it", () => {
    const reply = "Иногда пауза помогает прояснить чувства и решить, как двигаться дальше. Но, конечно, ты сама знаешь, что лучше.";
    assert.equal(polishMergedReply(reply), reply);
  });

  it("keeps «дальше» in the middle of a sentence", () => {
    const reply = "Что будет дальше и как вы это переживёте, зависит от вас обоих.";
    assert.equal(polishMergedReply(reply), reply);
  });

  it("keeps «дальше» before a question mark, an exclamation mark or an ellipsis", () => {
    for (const reply of ["Что делать дальше? Расскажи.", "Идём дальше! Давай разберём.", "Это длится дальше… Но выход есть."]) {
      assert.equal(polishMergedReply(reply), reply);
    }
  });
});

describe("a stray «дальше» marker between continuation chunks is still removed", () => {
  it("removes a «дальше» that stands alone on its own line", () => {
    assert.equal(stripOrphanContinueMarkers("Первая часть.\n\nдальше\n\nВторая часть."), "Первая часть.\n\nВторая часть.");
    assert.equal(stripOrphanContinueMarkers("Первая часть.\nДальше.\nВторая часть."), "Первая часть.\n\nВторая часть.");
  });

  it("removes a «дальше» line that follows a dash", () => {
    assert.equal(stripOrphanContinueMarkers("Это важная мысль —\n\nдальше.\n\nпродолжение мысли"), "Это важная мысль — продолжение мысли");
  });

  it("drops a «Дальше» at the very start of a continuation when gluing two segments", () => {
    const merged = mergeContinuationWithoutOverlap("Мне важно понять,", "Дальше: что ты чувствуешь");
    assert.equal(merged.text.includes("Дальше"), false);
    assert.equal(merged.text.includes("что ты чувствуешь"), true);
  });
});
