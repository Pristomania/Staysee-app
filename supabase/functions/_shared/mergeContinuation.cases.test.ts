/**
 * mergeContinuation paragraph_sep cases.
 * Run: npx tsx supabase/functions/_shared/mergeContinuation.cases.test.ts
 */

import { mergeContinuationWithoutOverlap } from "./mergeContinuation.ts";

const cases = [
  {
    name: "incomplete + new sentence (uppercase)",
    partA: "Мне важно понять",
    partB: "Что ты чувствуешь?",
    expected: "Мне важно понять.\n\nЧто ты чувствуешь?",
  },
  {
    name: "comma connector + lowercase continuation",
    partA: "Мне важно понять,",
    partB: "что ты чувствуешь",
    expected: "Мне важно понять, что ты чувствуешь",
  },
  {
    name: "complete sentence + new paragraph",
    partA: "Я рядом.",
    partB: "Что сейчас главное?",
    expected: "Я рядом.\n\nЧто сейчас главное?",
  },
  {
    name: "dash connector + lowercase continuation",
    partA: "Я слышу это —",
    partB: "и хочу уточнить",
    expected: "Я слышу это — и хочу уточнить",
  },
  {
    name: "incomplete clause + uppercase new sentence",
    partA: "Похоже, ты устала",
    partB: "Расскажи чуть больше",
    expected: "Похоже, ты устала.\n\nРасскажи чуть больше",
  },
];

let failed = 0;
for (const c of cases) {
  const result = mergeContinuationWithoutOverlap(c.partA, c.partB);
  const pass = result.text === c.expected && result.strategy === "paragraph_sep";
  console.log(`${pass ? "PASS" : "FAIL"}: ${c.name}`);
  if (!pass) {
    failed++;
    console.log(`  partA: ${JSON.stringify(c.partA)}`);
    console.log(`  partB: ${JSON.stringify(c.partB)}`);
    console.log(`  expected: ${JSON.stringify(c.expected)}`);
    console.log(`  got:      ${JSON.stringify(result.text)}`);
    console.log(`  strategy: ${result.strategy}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} cases passed.`);
