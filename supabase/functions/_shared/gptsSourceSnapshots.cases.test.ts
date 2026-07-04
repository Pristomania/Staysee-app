/**
 * PR8 GPTs source snapshot plumbing — file existence and anchor phrases.
 * Run: npx tsx supabase/functions/_shared/gptsSourceSnapshots.cases.test.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const ROOT = resolve(process.cwd());
const SNAPSHOT_DIR = resolve(ROOT, "docs/gpts-source");

const SNAPSHOTS = [
  "01-promt.md",
  "02-instrukciya-obshcheniya.md",
  "03-rukovodstvo-gpts.md",
  "04-unac-metodologiya.md",
  "05-protokol-sessij.md",
] as const;

const contents: Record<string, string> = {};
for (const name of SNAPSHOTS) {
  const path = resolve(SNAPSHOT_DIR, name);
  assert(existsSync(path), `snapshot missing: docs/gpts-source/${name}`);
  contents[name] = readFileSync(path, "utf8");
  assert(
    contents[name].includes("verbatim extraction for PR8 source transplant"),
    `${name} missing extraction note header`
  );
}

console.log("✓ all five gpts-source snapshots exist with extraction header");

const corpus = Object.values(contents).join("\n");
const extractionComplete =
  !corpus.includes("extraction status:** PENDING") &&
  !corpus.includes("extraction status:** INTERIM") &&
  !corpus.includes("EXTRACTION PENDING");

type AnchorSpec = { label: string; test: (text: string) => boolean };

const anchors: AnchorSpec[] = [
  {
    label: "виртуальный тренер осознанной жизни",
    test: (t) => /виртуальный тренер осознанной жизни/i.test(t),
  },
  {
    label: "психолог консультант с навыками коучинга",
    test: (t) => /психолог[- ]консультант с навыками коучинга/i.test(t),
  },
  {
    label: "Максимум 50-70 слов",
    test: (t) => /максимум\s+50[-–]70\s+слов/i.test(t),
  },
  {
    label: "Не более 3-4 предложений",
    test: (t) => /не более\s+3[-–]4\s+предложений/i.test(t),
  },
  {
    label: "Один вопрос в конце (or equivalent)",
    test: (t) =>
      /один вопрос в конце/i.test(t) ||
      /максимум\s+2[-–]3\s+вопрос/i.test(t) ||
      /каждый ответ — один шаг, одна идея/i.test(t),
  },
  {
    label: "маленьких шагов",
    test: (t) => /маленьких шагов/i.test(t),
  },
  {
    label: "эмоционального интеллекта",
    test: (t) => /эмоционального интеллекта/i.test(t),
  },
];

const interimOptional = new Set([
  "виртуальный тренер осознанной жизни",
  "Максимум 50-70 слов",
  "Не более 3-4 предложений",
]);

for (const { label, test } of anchors) {
  const found = test(corpus);
  if (found) {
    console.log(`✓ anchor: ${label}`);
    continue;
  }
  if (!extractionComplete && interimOptional.has(label)) {
    console.log(`~ anchor deferred (interim extraction): ${label}`);
    continue;
  }
  assert(found, `anchor phrase missing from snapshots: ${label}`);
}

if (!extractionComplete) {
  console.log(
    "\nNOTE: mechanical docx extraction pending for 03–05 and/or re-extraction for 01–02; deferred anchors require docs/gpts-source/_source/*.docx"
  );
}

console.log("\nAll gptsSourceSnapshots cases passed.");
