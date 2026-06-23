/**
 * Safety classifier regression cases.
 * Run: npx tsx supabase/functions/_shared/safety.cases.test.ts
 */

import { classifyMessage } from "./safety.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertCategory(message: string, expected: string): void {
  const category = classifyMessage(message);
  assert(
    category === expected,
    `expected ${expected} for "${message}", got ${category}`
  );
}

function assertNotLegal(message: string): void {
  const category = classifyMessage(message);
  assert(
    category !== "legal_financial_boundary",
    `expected not legal_financial_boundary for "${message}", got ${category}`
  );
}

console.log("=== legacy legal/financial word triggers disabled ===\n");

for (const phrase of [
  "давай закончим",
  "закончим здесь",
  "что говорит закон",
  "по закону",
  "законно ли это",
  "нужен юрист",
  "судебный процесс",
  "налоги",
  "кредит",
  "банкротство",
  "договор",
  "иск",
  "долг",
  "закон",
  "я искренне не понимаю",
  "я долго это терпел",
]) {
  assertNotLegal(phrase);
  console.log(`PASS: not legal — ${phrase} (${classifyMessage(phrase)})`);
}

console.log("\n=== critical safety still active ===\n");

const criticalCases: Array<[string, string]> = [
  ["я хочу умереть", "crisis"],
  ["я хочу причинить себе вред", "crisis"],
  ["я собираюсь покончить с собой", "crisis"],
  ["меня избивают", "crisis"],
  ["какое лекарство принять", "medical_boundary"],
  ["поставить диагноз", "medical_boundary"],
  ["отменить антидепрессанты", "medical_boundary"],
];

for (const [phrase, expected] of criticalCases) {
  assertCategory(phrase, expected);
  console.log(`PASS: ${phrase} → ${expected}`);
}

console.log(
  "\n=== future semantic protocol (not keyword gaps — do not add triggers) ===\n"
);
for (const phrase of [
  "у меня симптомы инфаркта",
  "мне плохо, я теряю сознание",
]) {
  const category = classifyMessage(phrase);
  console.log(
    `NOTE: "${phrase}" → ${category} (expected normal until semantic medical/crisis boundary rebuild)`
  );
}

console.log("\nAll safety cases passed.");
