/**
 * mergeContinuation + polish cases.
 * Run: npx tsx supabase/functions/_shared/mergeContinuation.cases.test.ts
 */

import {
  mergeContinuationWithoutOverlap,
  normalizeLongReplyParagraphs,
  polishMergedReply,
} from "./mergeContinuation.ts";

type MergeCase = {
  name: string;
  partA: string;
  partB: string;
  assert: (result: ReturnType<typeof mergeContinuationWithoutOverlap>) => void;
};

const mergeCases: MergeCase[] = [
  {
    name: "incomplete + new sentence (uppercase)",
    partA: "Мне важно понять",
    partB: "Что ты чувствуешь?",
    assert: (r) => {
      if (r.text !== "Мне важно понять.\n\nЧто ты чувствуешь?") throw new Error(`text: ${JSON.stringify(r.text)}`);
      if (r.strategy !== "paragraph_sep") throw new Error(`strategy: ${r.strategy}`);
    },
  },
  {
    name: "comma connector + lowercase continuation",
    partA: "Мне важно понять,",
    partB: "что ты чувствуешь",
    assert: (r) => {
      if (r.text !== "Мне важно понять, что ты чувствуешь") throw new Error(`text: ${JSON.stringify(r.text)}`);
    },
  },
  {
    name: "complete sentence + new paragraph",
    partA: "Я рядом.",
    partB: "Что сейчас главное?",
    assert: (r) => {
      if (r.text !== "Я рядом.\n\nЧто сейчас главное?") throw new Error(`text: ${JSON.stringify(r.text)}`);
    },
  },
  {
    name: "dash connector + lowercase continuation",
    partA: "Я слышу это —",
    partB: "и хочу уточнить",
    assert: (r) => {
      if (r.text !== "Я слышу это — и хочу уточнить") throw new Error(`text: ${JSON.stringify(r.text)}`);
    },
  },
  {
    name: "incomplete clause + uppercase new sentence",
    partA: "Похоже, ты устала",
    partB: "Расскажи чуть больше",
    assert: (r) => {
      if (r.text !== "Похоже, ты устала.\n\nРасскажи чуть больше") throw new Error(`text: ${JSON.stringify(r.text)}`);
    },
  },
  {
    name: "mid-word Cyrillic: момен + т",
    partA: "Это важный момен",
    partB: "т, потому что...",
    assert: (r) => {
      if (r.text !== "Это важный момент, потому что...") throw new Error(`text: ${JSON.stringify(r.text)}`);
      if (r.strategy !== "partial_word") throw new Error(`strategy: ${r.strategy}`);
    },
  },
  {
    name: "mid-word Cyrillic: отв + ет",
    partA: "это был отв",
    partB: "ет, который...",
    assert: (r) => {
      if (r.text !== "это был ответ, который...") throw new Error(`text: ${JSON.stringify(r.text)}`);
      if (r.strategy !== "partial_word") throw new Error(`strategy: ${r.strategy}`);
    },
  },
  {
    name: "mid-word: изб + ранных",
    partA: "способность любить изб",
    partB: "ранных людей",
    assert: (r) => {
      if (r.text !== "способность любить избранных людей") throw new Error(`text: ${JSON.stringify(r.text)}`);
      if (r.strategy !== "partial_word") throw new Error(`strategy: ${r.strategy}`);
    },
  },
  {
    name: "false period izb. + ранных",
    partA: "способность любить изб.",
    partB: "ранных людей",
    assert: (r) => {
      if (r.text !== "способность любить избранных людей") throw new Error(`text: ${JSON.stringify(r.text)}`);
      if (r.strategy !== "partial_word") throw new Error(`strategy: ${r.strategy}`);
    },
  },
  {
    name: "lowercase after sentence → paragraph",
    partA: "Это причиняет боль другим.",
    partB: "проблемы возникают позже.",
    assert: (r) => {
      if (r.text.includes(". проблемы")) throw new Error(`glued lowercase: ${JSON.stringify(r.text)}`);
      if (!r.text.includes("\n\n")) throw new Error(`expected paragraph break: ${JSON.stringify(r.text)}`);
      if (!r.text.includes("Проблемы")) throw new Error(`expected capitalized: ${JSON.stringify(r.text)}`);
    },
  },
  {
    name: "list duplicate: truncated izb. + full item repeat",
    partA:
      "черты:\nнизкая эмпатия к большинству людей, но сохранённая способность любить изб.",
    partB:
      "низкая эмпатия к большинству людей, но сохранённая способность любить избранных;\nспособность к контролю и рефлексии",
    assert: (r) => {
      if (r.text.includes("изб.")) throw new Error(`still has izb.: ${JSON.stringify(r.text)}`);
      if (!r.text.includes("избранных")) throw new Error(`missing избранных: ${JSON.stringify(r.text)}`);
      const count = (r.text.match(/низкая эмпатия к большинству людей/g) ?? []).length;
      if (count !== 1) throw new Error(`duplicate list item (${count}x): ${JSON.stringify(r.text)}`);
      if (!r.text.includes("способность к контролю")) throw new Error(`missing tail: ${JSON.stringify(r.text)}`);
      if (r.strategy !== "list_dedupe") throw new Error(`strategy: ${r.strategy}`);
    },
  },
];

let failed = 0;

for (const c of mergeCases) {
  try {
    const result = mergeContinuationWithoutOverlap(c.partA, c.partB);
    c.assert(result);
    console.log(`PASS: ${c.name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL: ${c.name}`);
    console.log(`  ${err instanceof Error ? err.message : err}`);
    const result = mergeContinuationWithoutOverlap(c.partA, c.partB);
    console.log(`  got: ${JSON.stringify(result.text)} strategy=${result.strategy}`);
  }
}

// normalizeLongReplyParagraphs
const wall =
  "Вступление про тему. " +
  "1. Первый блок про мысленную жестокость и то как это проявляется. " +
  "2. Второй блок про агрессию и импульсы в повседневной жизни. " +
  "3. Третий блок про отношения с близкими и семьёй. ".repeat(40);

try {
  const normalized = normalizeLongReplyParagraphs(wall);
  if (normalized.length < 2000) throw new Error("wall too short");
  if (!/\n\n1\./.test(normalized) && !/\n\n2\./.test(normalized)) {
    throw new Error("expected breaks before numbered sections");
  }
  if ((normalized.match(/\n\n/g) ?? []).length < 2) throw new Error("expected multiple paragraph breaks");
  console.log("PASS: wall of text paragraph normalization");
} catch (err) {
  failed++;
  console.log(`FAIL: wall of text paragraph normalization`);
  console.log(`  ${err instanceof Error ? err.message : err}`);
}

try {
  const short = normalizeLongReplyParagraphs("Короткий ответ без списков.");
  if (short !== "Короткий ответ без списков.") throw new Error("short message changed");
  console.log("PASS: short message unchanged");
} catch (err) {
  failed++;
  console.log(`FAIL: short message unchanged`);
  console.log(`  ${err instanceof Error ? err.message : err}`);
}

// polishMergedReply end-to-end for Egor-like segments
try {
  const a =
    "черты:\nнизкая эмпатия к большинству людей, но сохранённая способность любить изб.";
  const b =
    "низкая эмпатия к большинству людей, но сохранённая способность любить избранных;\nспособность к контролю.";
  const merged = polishMergedReply(
    mergeContinuationWithoutOverlap(a, b).text,
  );
  if (merged.includes("изб.")) throw new Error("polish left izb.");
  if ((merged.match(/низкая эмпатия/g) ?? []).length !== 1) throw new Error("polish duplicate");
  console.log("PASS: polishMergedReply egor-like");
} catch (err) {
  failed++;
  console.log(`FAIL: polishMergedReply egor-like`);
  console.log(`  ${err instanceof Error ? err.message : err}`);
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${mergeCases.length + 3} checks passed.`);
