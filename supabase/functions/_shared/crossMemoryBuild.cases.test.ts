/**
 * Run: npx tsx supabase/functions/_shared/crossMemoryBuild.cases.test.ts
 */

import {
  buildCrossMemoryCandidates,
  eventToFactEvolutionCandidate,
} from "./crossMemoryBuild.ts";
import { filterCrossMemoryCandidates } from "./crossMemoryPolicy.ts";
import {
  evolveMemoryFacts,
  isFactEvolutionCandidateText,
  type ExistingFactRow,
} from "./factEvolution.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function expectEventCandidate(event: string, label: string): void {
  const c = eventToFactEvolutionCandidate(event);
  assert(c !== null, `${label}: expected candidate for "${event}"`);
  assert(c!.memory_type === "life_context", `${label}: expected life_context`);
  console.log(`PASS: ${label} → ${c!.content.replace(/[.!?…]+$/u, "")}`);
}

function expectNoEventCandidate(event: string, label: string): void {
  assert(
    eventToFactEvolutionCandidate(event) === null,
    `${label}: should not promote "${event}"`
  );
  assert(
    !isFactEvolutionCandidateText(event),
    `${label}: isFactEvolutionCandidateText should be false`
  );
  console.log(`PASS: ${label} → blocked`);
}

function applyCandidates(
  rows: ExistingFactRow[],
  memory: {
    people: string[];
    preferences: string[];
    important_events?: string[];
  }
): ExistingFactRow[] {
  let tracked = [...rows];
  const candidates = filterCrossMemoryCandidates(buildCrossMemoryCandidates(memory));

  for (const c of candidates) {
    const evolution = evolveMemoryFacts(tracked, c);
    if (!evolution || evolution.action === "ignore") continue;
    if (
      evolution.action !== "add" &&
      evolution.action !== "enrich" &&
      evolution.action !== "replace"
    ) {
      continue;
    }
    for (const id of evolution.deleteRowIds ?? []) {
      tracked = tracked.filter((r) => r.id !== id);
    }
    tracked.push({
      id: `row-${tracked.length + 1}`,
      content: evolution.content,
      memory_type: evolution.memory_type,
    });
  }
  return tracked;
}

console.log("=== important_events fact-slot promotion ===\n");

expectEventCandidate("сыну 18", "son age event");
expectEventCandidate("сын живёт со мной", "son living event");
expectEventCandidate("сын ушёл в армию", "son army event");
expectEventCandidate("сын, 18 лет", "son age phrase");
expectEventCandidate("сын сейчас в армии", "son army phrase");
expectEventCandidate("партнёр часто остаётся на ночь", "partner overnight");
expectEventCandidate("мы съехались", "partner living together");
expectEventCandidate("собаку зовут Крис", "pet name");

console.log("\n=== blocked important_events ===\n");

expectNoEventCandidate(
  "племянница с дипломом психолога создала пару с сыном, причинив боль",
  "family conflict plot"
);
expectNoEventCandidate("купила курс по психологии", "course episode");
expectNoEventCandidate("преподаватель сказал важную фразу", "teacher quote");
expectNoEventCandidate("сын расстроил пользователя", "emotional son mention");

console.log("\n=== summary bridge integration ===\n");

const summaryMemory = {
  people: ["сын"],
  preferences: [] as string[],
  important_events: ["сыну 18", "сын живёт со мной", "сын ушёл в армию"],
};

const finalRows = applyCandidates([], summaryMemory);
const sonRows = finalRows.filter(
  (r) => r.memory_type === "life_context" && /сын/i.test(r.content)
);

assert(sonRows.length === 1, `expected one son row, got ${sonRows.length}`);
const canonical = sonRows[0]!.content.replace(/[.!?…]+$/u, "");
assert(
  canonical === "сын, 18 лет, сейчас в армии",
  `expected canonical son, got "${canonical}"`
);
assert(
  !finalRows.some((r) => /живёт со мной/i.test(r.content)),
  "living_with_me row should be replaced"
);
assert(
  !finalRows.some((r) => /^есть\s+сын$/iu.test(r.content.replace(/[.!?…]+$/u, ""))),
  "bare есть сын should not remain"
);
console.log("PASS: summary people + events → canonical son");

console.log("\n=== crossMemoryBuild.cases.test.ts OK ===\n");
