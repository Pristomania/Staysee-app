/**
 * Regression smoke: Egor dialog merge patterns (synthetic segments).
 * Run: npx tsx scripts/replay-egor-merge-smoke.mjs
 */

import { readFileSync } from "node:fs";
import {
  mergeContinuationWithoutOverlap,
  normalizeLongReplyParagraphs,
  polishMergedReply,
} from "../supabase/functions/_shared/mergeContinuation.ts";

const checks = [];

function assert(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- Synthetic Egor 16.06 cases ---

const izbA =
  "черты:\nнизкая эмпатия к большинству людей, но сохранённая способность любить изб.";
const izbB =
  "низкая эмпатия к большинству людей, но сохранённая способность любить избранных;\nспособность к контролю и рефлексии, которая отличает тебя от классической психопатии.";

const izbMerged = polishMergedReply(
  mergeContinuationWithoutOverlap(izbA, izbB).text,
);

assert("no izb. fragment", !izbMerged.includes("изб."));
assert("contains избранных", izbMerged.includes("избранных"));
assert(
  "single list item (низкая эмпатия)",
  (izbMerged.match(/низкая эмпатия к большинству людей/g) ?? []).length === 1,
);
assert("ends on sentence", /[.!?…]\s*$/.test(izbMerged.trim()));

const painA = "Человек с классической психопатией обычно не беспокоится о том, что причиняет боль другим.";
const painB = "проблемы или последствия, но не сама боль другого человека.";
const painMerged = mergeContinuationWithoutOverlap(painA, painB).text;

assert("no . проблемы glue", !painMerged.includes(". проблемы"));
assert("paragraph or capital after period", /\n\nПроблемы/.test(painMerged));

// Wall-of-text sample (5925-char pattern): numbered inline blocks
let wallSample = "Хорошо. Давай разберём по блокам. ";
for (let i = 1; i <= 5; i++) {
  wallSample += `${i}. Блок ${i} с анализом и пояснением, которое занимает место в длинном ответе. `.repeat(15);
}
const wallNorm = normalizeLongReplyParagraphs(wallSample);

assert("wall has paragraph breaks", (wallNorm.match(/\n\n/g) ?? []).length >= 2);
assert("wall still has numbered content", /2\./.test(wallNorm));

// Mid-word probes
const mid = mergeContinuationWithoutOverlap("Это важный момен", "т, потому что...");
assert("mid-word момент", mid.text === "Это важный момент, потому что...");

const ot = mergeContinuationWithoutOverlap("это был отв", "ет, который...");
assert("mid-word ответ", ot.text === "это был ответ, который...");

// --- audit-egor-dialog.json long wall message if present ---
try {
  const audit = JSON.parse(readFileSync("audit-egor-dialog.json", "utf8"));
  const longMsg = audit.timeline?.find(
    (m) => m.role === "assistant" && m.char_len > 5500 && m.paragraphs === 1,
  );
  if (longMsg?.content) {
    const norm = normalizeLongReplyParagraphs(longMsg.content);
    const breaks = (norm.match(/\n\n/g) ?? []).length;
    assert(
      "audit long msg gets breaks",
      breaks >= 1,
      `paragraphs ${longMsg.paragraphs} → ${breaks} breaks`,
    );
    assert(
      "audit long msg no shorter than 90%",
      norm.length >= longMsg.content.length * 0.9,
      `${longMsg.content.length} → ${norm.length}`,
    );
  } else {
    console.log("SKIP: no long wall message in audit-egor-dialog.json");
  }
} catch {
  console.log("SKIP: audit-egor-dialog.json not readable");
}

const failed = checks.filter((c) => !c.ok).length;
if (failed > 0) {
  console.error(`\n${failed} smoke check(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${checks.length} smoke checks passed.`);
