/**
 * The rule for the end of a reply (owner's decision, 20.11.2026): no lists of words, no cutting by length, nothing decided by what a
 * reply says.
 *  - A reply the model finished on its own (finish_reason other than "length") is shown as it is: never repaired, never trimmed,
 *    never generated again, never replaced by an error text, whatever its last character is.
 *  - A reply the model was CUT in (finish_reason "length") is continued once; if it still stops short of a sentence mark, it is
 *    trimmed to the last sentence mark (never to nothing).
 *  - An ending is a sentence mark (. ? ! …, possibly followed by a closing quote or bracket) or an emoji.
 *  - After a continuation is joined, nothing is removed from the text by phrases.
 * Run: npx tsx supabase/functions/_shared/replyEndingRule.cases.test.ts
 */

import * as completeReply from "./completeReply.ts";
import {
  ensurePublishableReply,
  isClearlyTruncatedForFinalize,
  isPublishableReply,
  shouldRunFinalize,
} from "./completeReply.ts";
import { endsAtSentenceBoundary, hasBrokenEnding } from "./replyEnding.ts";
import { classifyInitialRoute, mergeLengthContinuation, runReplyRecoveryRoutes } from "./replyRecovery.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function same(actual: unknown, expected: unknown, message: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

// ── what an ending is: a mark or an emoji, and nothing else (no word lists) ────────────────────────────────
for (const ok of ["Всё хорошо.", "Правда?", "Ура!", "Так…", "Она сказала «да».", "Она сказала: «да.»", "Хорошо 🙂", "Хорошо.🙂", "(как-то так.)", 'Он сказал "ладно."']) {
  assert(endsAtSentenceBoundary(ok), `an ending: ${ok}`);
}
for (const notYet of ["Спокойной ночи", "Это важно, потому что", "и", "Хорошо, но", "в этом мол", "Первая мысль. Вторая без конца"]) {
  assert(!endsAtSentenceBoundary(notYet), `not an ending by itself: ${notYet}`);
}
// A dash, colon, comma or semicolon at the very end is a sentence that was cut; words are never looked at.
for (const cut of ["Мы шли —", "Вот что:", "Сначала это,", "Ещё это;"]) assert(hasBrokenEnding(cut), `cut at a mark: ${cut}`);
for (const notCut of ["Хорошо, но", "Спокойной ночи", "в этом мол", "Всё хорошо."]) assert(!hasBrokenEnding(notCut), `no word guess: ${notCut}`);
console.log("✓ what an ending is");

// ── a reply the model finished is shown as it is ───────────────────────────────────────────────────────────
assert(isPublishableReply("Спокойной ночи", "stop"), "a finished warm closure without a mark");
assert(isPublishableReply("и вот что я думаю", "stop"), "finished means finished: its last word is not examined");
assert(isPublishableReply("Хорошо, но", "end_turn"), "any normal stop reason");
assert(!isPublishableReply("", "stop"), "but nothing is not a reply");
assert(!isPublishableReply("и вот что я думаю", "length"), "cut by length and no mark: not finished");
assert(isPublishableReply("Первая мысль.", "length"), "cut by length but ends on a mark: fine");

same(ensurePublishableReply("Первая мысль. Вторая без точки", "stop"), "Первая мысль. Вторая без точки", "a stopped reply is never trimmed");
same(ensurePublishableReply("Спокойной ночи", "stop"), "Спокойной ночи", "nor a short closure");
same(ensurePublishableReply("Первая мысль целиком. Вторая обо", "length"), "Первая мысль целиком.", "a cut reply is trimmed to its last mark");
same(ensurePublishableReply("одна длинная мысль без единого знака и обрыв", "length"), "одна длинная мысль без единого знака и обрыв", "never to nothing");
same(ensurePublishableReply("Первая мысль. Вторая без точки"), "Первая мысль. Вторая без точки", "with no reason given nothing is cut");
assert(!("needsStopNotPublishableRepair" in completeReply), "there is no repair route for a reply that stopped by itself (guard against bringing it back)");
console.log("✓ a finished reply is shown as it is");

// ── the route of a reply ───────────────────────────────────────────────────────────────────────────────────
same(classifyInitialRoute("и вот что я думаю", "stop"), "normal_publishable", "a stop never goes to repair, retry or fail-closed");
same(classifyInitialRoute("Первая. Вторая обор", "length"), "length_truncation_continue", "a cut goes to continue");
console.log("✓ the route of a reply");

// ── a cut reply: continued once, finalized only if still short of a mark ──────────────────────────────────
assert(shouldRunFinalize("Текст до обрыва и ещё", true), "after a continuation that still has no mark: close it");
assert(!shouldRunFinalize("Текст до обрыва.", true), "after a continuation that ends on a mark: nothing more");
assert(isClearlyTruncatedForFinalize("Мысль без конца и"), "no mark at the end of a cut reply: truncated");
assert(!isClearlyTruncatedForFinalize("Мысль закончена."), "a mark: not truncated");

{
  const calls: string[] = [];
  const stopped = await runReplyRecoveryRoutes({
    firstSegment: { content: "Спокойной ночи", finishReason: "stop" },
    baseModelMessages: [{ role: "user", content: "привет" }],
    unavailableMessage: "UNAVAILABLE",
    replyNotRecoveredMessage: "NOT RECOVERED",
    callModel: async (_messages, kind) => {
      calls.push(kind);
      return { content: "лишний вызов", finishReason: "stop" };
    },
  });
  same(stopped.content, "Спокойной ночи", "the stopped reply comes out unchanged");
  same(calls, [], "and costs no second model call");
  same(stopped.diagnostics.failClosedUsed, false, "and is never failed closed");

  const cutCalls: string[] = [];
  const cut = await runReplyRecoveryRoutes({
    firstSegment: { content: "Первая мысль. Вторая оборвалась на сло", finishReason: "length" },
    baseModelMessages: [{ role: "user", content: "привет" }],
    unavailableMessage: "UNAVAILABLE",
    callModel: async (_messages, kind) => {
      cutCalls.push(kind);
      return { content: "ве и закончилась.", finishReason: "stop" };
    },
  });
  same(cutCalls, ["auto_continue"], "a cut reply is continued once");
  assert(cut.content.endsWith("закончилась."), "and the continuation is joined");
}
console.log("✓ a cut reply is continued, a finished one is left alone");

// ── nothing is removed from a joined reply by phrases ──────────────────────────────────────────────────────
{
  const accumulated = "Хорошо.\n\nСпи спокойно, ты молодец.";
  const continuation = "Ты сегодня прошла большой путь и многое поняла.";
  const merged = mergeLengthContinuation(accumulated, continuation);
  assert(merged.content.includes("Ты сегодня прошла большой путь"), "a paragraph that follows a goodbye is kept (nothing is cut by phrases)");
  assert(merged.content.includes("Спи спокойно"), "and so is the goodbye");
}
console.log("✓ nothing is cut from a joined reply");

console.log("All replyEndingRule cases passed.");
