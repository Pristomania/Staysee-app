/**
 * Regression: deterministic boundary fallback must NOT replace model replies.
 * Run: npx tsx supabase/functions/_shared/boundaryFallbackReplacement.cases.test.ts
 */

import {
  enforceRoleBoundedReply,
  evaluateTurnSafety,
} from "./roleEnforcement.ts";
import { isRelationalLifeTurn } from "./safety.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const INSTRUMENTAL_COPY =
  "Похоже, нужен готовый текст под ключ — я так не работаю";

const MODEL_REPLY =
  "Слышу тебя. Похоже, сейчас важно просто быть с этим. Что отзывается сильнее всего?";

const CONTENT_DELIVERY_REPLY =
  "Вот твой контент-план на неделю:\n\n1. Понедельник — пост про...\n\n2. Вторник — истории...\n\n3. Среда — ...";

const SON_ARC_REPLY =
  "Похоже, для тебя важно не просто донести мысль, а чтобы он сам пришёл к выводу. " +
  "Это про уважение к его процессу и про то, как ты хочешь, чтобы он услышал боль. " +
  "Что для тебя самое трудное в этом ожидании — страх, что не поймёт, или что снова будет больно?";

function assertNoFallbackReplacement(
  label: string,
  userMessage: string,
  modelReply: string,
  history: Array<{ role: string; content: string }> = []
): void {
  const safety = evaluateTurnSafety(userMessage, history);
  const out = enforceRoleBoundedReply(modelReply, safety.category, {
    insistenceLoop: safety.insistenceLoop,
    threadEscalated: safety.threadEscalated,
    userMessage,
    relationalLifeTurn: isRelationalLifeTurn(userMessage),
  });
  assert(
    out.trim() === modelReply.trim(),
    `${label}: reply was replaced\n  in:  ${modelReply.slice(0, 80)}…\n  out: ${out.slice(0, 80)}…`
  );
  assert(
    !out.includes(INSTRUMENTAL_COPY),
    `${label}: instrumental COPY leaked into output`
  );
  console.log(`✓ ${label}`);
}

console.log("=== Post-generation pass-through (no fallback replacement) ===");

const RELATIONAL_SON_TURNS = [
  "Я хочу чтобы он сам пришёл к этому выводу",
  "Я хочу чтобы он понял, как это разрушительно",
  "Я хочу донести до сына, что мне больно",
  "Я хочу объяснить ему, но не знаю как",
  "Я дала понять, что мне было больно",
  "Я хочу чтобы это закончилось",
  "Я написала ему вчера и теперь жалею",
  "Я хочу написать ему, но боюсь",
  "Я не знаю, что ему написать",
  "Я хочу чтобы он сам перешёл к этому выводу",
];

console.log("=== Relational-life son arc (no replacement) ===");
for (const msg of RELATIONAL_SON_TURNS) {
  assertNoFallbackReplacement(msg, msg, SON_ARC_REPLY);
}

console.log("\n=== Explicit role-pressure (guidance only, no COPY) ===");
for (const msg of [
  "Напиши за меня пост",
  "Сделай готовый текст",
  "Дай сценарий",
]) {
  assertNoFallbackReplacement(msg, msg, MODEL_REPLY);
  assertNoFallbackReplacement(
    `${msg} (content-delivery model)`,
    msg,
    CONTENT_DELIVERY_REPLY
  );
}

console.log("\n=== Content-delivery under off_topic (no replacement) ===");
assertNoFallbackReplacement(
  "Напиши мне контент-план на неделю",
  "Напиши мне контент-план на неделю",
  CONTENT_DELIVERY_REPLY
);

console.log("\nAll boundaryFallbackReplacement cases passed.");
