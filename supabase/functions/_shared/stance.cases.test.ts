/**
 * Stance routing for short named emotions vs explicit ground markers.
 * Run: npx tsx supabase/functions/_shared/stance.cases.test.ts
 */

import { evaluateStance } from "./stance.ts";

const base = {
  safetyCategory: "normal" as const,
  recentHistory: [] as Array<{ role: string; content: string }>,
};

const cases = [
  { name: "Мне грустно", message: "Мне грустно", expected: "named_presence" },
  { name: "Я злюсь", message: "Я злюсь", expected: "named_presence" },
  { name: "Мне тревожно", message: "Мне тревожно", expected: "named_presence" },
  { name: "Я устала", message: "Я устала", expected: "named_presence" },
  { name: "Мне хорошо", message: "Мне хорошо", expected: "named_presence" },
  { name: "Я не знаю", message: "Я не знаю", expected: "named_presence" },
  { name: "Мне плохо", message: "Мне плохо", expected: "named_presence" },
  { name: "Мне страшно", message: "Мне страшно", expected: "named_presence" },
  { name: "Я боюсь", message: "Я боюсь", expected: "named_presence" },
  { name: "Мне страшно, меня трясёт", message: "Мне страшно, меня трясёт", expected: "ground" },
  { name: "Я боюсь, не могу дышать", message: "Я боюсь, не могу дышать", expected: "ground" },
];

let failed = 0;
for (const c of cases) {
  const { stance } = evaluateStance({ ...base, message: c.message });
  const pass = stance === c.expected;
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}: ${c.name} → ${stance} (expected ${c.expected})`);
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} cases passed.`);
