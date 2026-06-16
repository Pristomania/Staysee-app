/**
 * ensurePublishableReply cases.
 * Run: npx tsx supabase/functions/_shared/completeReply.cases.test.ts
 */

import { ensurePublishableReply, isPublishableReply } from "./completeReply.ts";

type Case = {
  name: string;
  input: string;
  assert: (out: string) => void;
};

const cases: Case[] = [
  {
    name: "valid Russian ending unchanged",
    input: "Ты способен любить избранных людей и заботиться о них.",
    assert: (out) => {
      if (out !== "Ты способен любить избранных людей и заботиться о них.") {
        throw new Error(`changed valid ending: ${JSON.stringify(out)}`);
      }
    },
  },
  {
    name: "valid short word ending unchanged",
    input: "Я здесь.",
    assert: (out) => {
      if (out !== "Я здесь.") throw new Error(`changed: ${JSON.stringify(out)}`);
    },
  },
  {
    name: "broken mid-word fragment trimmed",
    input: "Первый блок текста. Сейчас это очень важный момен",
    assert: (out) => {
      if (out.includes("момен")) throw new Error(`left fragment: ${JSON.stringify(out)}`);
      if (!isPublishableReply(out)) throw new Error(`not publishable: ${JSON.stringify(out)}`);
    },
  },
  {
    name: "does not strip valid 6-char final word",
    input: "Текст заканчивается словом важным",
    assert: (out) => {
      if (!out.endsWith("важным") && !out.endsWith(".")) {
        throw new Error(`unexpected trim: ${JSON.stringify(out)}`);
      }
    },
  },
  {
    name: "em-dash cut trimmed to last sentence",
    input: "Первое предложение. Второе обрывается —",
    assert: (out) => {
      if (out.includes("—")) throw new Error(`left dash: ${JSON.stringify(out)}`);
      if (!out.includes("Первое предложение.")) throw new Error(`lost sentence: ${JSON.stringify(out)}`);
    },
  },
];

let failed = 0;

for (const c of cases) {
  try {
    const out = ensurePublishableReply(c.input);
    c.assert(out);
    console.log(`PASS: ${c.name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL: ${c.name}`);
    console.log(`  ${err instanceof Error ? err.message : err}`);
    console.log(`  got: ${JSON.stringify(ensurePublishableReply(c.input))}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} cases passed.`);
