/**
 * Run: npx tsx supabase/functions/_shared/factEvolution.cases.test.ts
 */

import {
  collapseEvolvedLifeContextRows,
  evolveMemoryFacts,
  type ExistingFactRow,
} from "./factEvolution.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function row(content: string, id?: string): ExistingFactRow {
  return { id, content, memory_type: "life_context" };
}

function evolve(
  existing: ExistingFactRow[],
  candidate: string
): ReturnType<typeof evolveMemoryFacts> {
  return evolveMemoryFacts(existing, {
    memory_type: "life_context",
    content: candidate,
  });
}

function expectContent(
  decision: ReturnType<typeof evolveMemoryFacts>,
  expected: string,
  label: string
): void {
  assert(decision !== null, `${label}: expected decision`);
  if (decision!.action === "ignore") {
    throw new Error(`${label}: unexpected ignore — ${decision!.reason}`);
  }
  const got = decision!.content.replace(/[.!?…]+$/u, "");
  const want = expected.replace(/[.!?…]+$/u, "");
  assert(got === want, `${label}: expected "${want}", got "${got}"`);
}

function expectNoRemaining(
  existing: ExistingFactRow[],
  decision: ReturnType<typeof evolveMemoryFacts>,
  forbidden: RegExp,
  label: string
): void {
  assert(decision !== null && decision.action !== "ignore", `${label}: need decision`);
  const remaining = existing
    .filter((r) => !decision!.replacedContents?.includes(r.content))
    .map((r) => r.content);
  const final = [decision!.content, ...remaining];
  assert(
    !final.some((c) => forbidden.test(c)),
    `${label}: forbidden pattern still present in ${JSON.stringify(final)}`
  );
}

console.log("=== son enrichment ===\n");

let d = evolve([row("сын", "1")], "сын, 18 лет");
expectContent(d, "сын, 18 лет", "son age enrich");
console.log("PASS: son + age → сын, 18 лет");

console.log("\n=== son living status enrich ===\n");

d = evolve([row("сын, 18 лет", "1")], "сын живёт со мной");
expectContent(d, "сын, 18 лет, живёт со мной", "son lives with me");
console.log("PASS: son living enrich");

console.log("\n=== son army replacement ===\n");

const beforeArmy = [row("сын, 18 лет, живёт со мной", "1")];
d = evolve(beforeArmy, "сын сейчас в армии");
expectContent(d, "сын, 18 лет, сейчас в армии", "son army");
expectNoRemaining(beforeArmy, d, /живёт со мной/i, "son army no lives_with_me");
console.log("PASS: son army replaces living status");

console.log("\n=== partner soft transition ===\n");

const beforePartner = [row("партнёр не живёт вместе", "p1")];
d = evolve(beforePartner, "партнёр часто остаётся на ночь");
expectContent(d, "партнёр часто остаётся на ночь", "partner overnight");
expectNoRemaining(beforePartner, d, /не живёт вместе/i, "partner overnight no separate");
console.log("PASS: partner soft update");

console.log("\n=== partner clear replacement ===\n");

const beforeTogether = [row("партнёр не живёт вместе", "p1")];
d = evolve(beforeTogether, "живём вместе с партнёром");
expectContent(d, "живём вместе с партнёром", "partner together");
expectNoRemaining(beforeTogether, d, /не живёт вместе/i, "partner together");
console.log("PASS: partner living together");

console.log("\n=== pet enrichment ===\n");

d = evolve([row("есть собака", "d1")], "есть собака Крис");
expectContent(d, "есть собака Крис", "pet name");
console.log("PASS: pet name enrich");

console.log("\n=== communication non-replacement ===\n");

const commExisting: ExistingFactRow[] = [
  { id: "c1", content: "важна прямота", memory_type: "communication" },
];
const comm = evolveMemoryFacts(commExisting, {
  memory_type: "communication",
  content: "не нужны пустые слова — нужно присутствие",
});
assert(comm === null, "communication should bypass evolution");
console.log("PASS: communication bypasses fact evolution");

console.log("\n=== ambiguous pronoun blocked ===\n");

const amb = evolve([], "он стал часто ночевать");
assert(amb?.action === "ignore", "ambiguous pronoun blocked");
console.log("PASS: ambiguous pronoun → ignore");

console.log("\n=== injection collapse ===\n");

const collapsed = collapseEvolvedLifeContextRows([
  { memory_type: "life_context", content: "сын, 18 лет, живёт со мной." },
  { memory_type: "life_context", content: "сын, 18 лет, сейчас в армии." },
  { memory_type: "communication", content: "важна прямота." },
]);
const life = collapsed.filter((r) => r.memory_type === "life_context");
assert(life.length === 1, `expected 1 life row, got ${life.length}`);
assert(/армии/i.test(life[0].content), "collapsed to army state");
assert(
  collapsed.some((r) => r.memory_type === "communication"),
  "communication kept"
);
console.log("PASS: injection collapse keeps canonical son row");

console.log("\n=== factEvolution.cases.test.ts OK ===\n");
