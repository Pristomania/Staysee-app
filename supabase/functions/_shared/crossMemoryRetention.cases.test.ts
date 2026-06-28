/**
 * Run: npx tsx supabase/functions/_shared/crossMemoryRetention.cases.test.ts
 */

import {
  filterCrossMemoryCandidates,
  isPromotableToCrossMemory,
  normalizePeopleFieldToLifeContext,
} from "./crossMemoryPolicy.ts";
import { consolidateRowsRuleBased } from "./consolidateRuleBased.ts";
import { buildCrossMemoryCandidates } from "./crossMemoryBuild.ts";
import type { CrossMemoryBuildInput } from "./crossMemoryBuild.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function mem(partial: CrossMemoryBuildInput & Record<string, unknown>): CrossMemoryBuildInput {
  return {
    people: [],
    preferences: [],
    ...partial,
  };
}

console.log("=== people retention ===\n");

const peopleMem = mem({ people: ["сын", "собака Крис"] });
const peopleCandidates = buildCrossMemoryCandidates(peopleMem);
assert(
  peopleCandidates.some((c) => /сын/i.test(c.content)),
  "son candidate missing"
);
assert(
  peopleCandidates.some((c) => /крис|собак/i.test(c.content)),
  "pet candidate missing"
);
console.log("PASS: son + pet both present");

const sonNorm = normalizePeopleFieldToLifeContext("сын");
assert(sonNorm !== null && /сын/i.test(sonNorm), "normalize son");
console.log("PASS: short son normalizes");

console.log("\n=== preference retention ===\n");

const prefMem = mem({
  preferences: [
    "не нужны советы",
    "лучше прямо и по делу",
    "обращаться в женском роде",
  ],
});
const prefCandidates = buildCrossMemoryCandidates(prefMem);
assert(prefCandidates.length >= 3, `expected 3 prefs, got ${prefCandidates.length}`);
console.log("PASS: all communication preferences retained");

console.log("\n=== mixed allowed + blocked ===\n");

const mixed = mem({
  people: [
    "У пользователя есть сын",
    "У пользователя есть собака Крис",
    "Пользователь работает над приложением StaySee",
  ],
  preferences: ["Обращаться ко мне в женском роде"],
  important_events: [
    "Пользователь купила курс, но считает, что у преподавателя недостаточно компетенций",
  ],
  themes: ["Сегодня пользователь выбирает красный для яркости"],
});
const mixedCandidates = buildCrossMemoryCandidates(mixed);
assert(mixedCandidates.some((c) => /сын/i.test(c.content)), "mixed son");
assert(mixedCandidates.some((c) => /крис|собак/i.test(c.content)), "mixed pet");
assert(mixedCandidates.some((c) => /staysee|стэйси/i.test(c.content)), "mixed project");
assert(mixedCandidates.some((c) => /женск/i.test(c.content)), "mixed feminine");
assert(
  !mixedCandidates.some((c) => /курс|преподав|красн/i.test(c.content)),
  "blocked content leaked"
);
assert(mixedCandidates.length >= 4, `expected >=4 allowed rows, got ${mixedCandidates.length}`);
console.log("PASS: mixed allowed survive, blocked removed");

console.log("\n=== consolidate retention ===\n");

const consolidated = consolidateRowsRuleBased([
  {
    id: "1",
    user_id: "u",
    memory_type: "life_context",
    content: "У пользователя есть сын",
  },
  {
    id: "2",
    user_id: "u",
    memory_type: "life_context",
    content: "У пользователя есть собака Крис",
  },
  {
    id: "3",
    user_id: "u",
    memory_type: "communication",
    content: "Пользователь предпочитает прямоту без пустых советов",
  },
]);
assert(consolidated.length === 3, `expected 3 consolidated rows, got ${consolidated.length}`);
assert(
  consolidated.some((c) => c.memory_type === "life_context" && /сын/i.test(c.content)),
  "consolidate son"
);
assert(
  consolidated.some((c) => c.memory_type === "life_context" && /крис/i.test(c.content)),
  "consolidate pet"
);
assert(
  consolidated.some((c) => c.memory_type === "communication" && /прям/i.test(c.content)),
  "consolidate communication"
);
assert(
  !consolidated.some((c) => /В жизни пользователя значимы/i.test(c.content)),
  "no display prefix"
);
console.log("PASS: consolidate keeps three meanings");

console.log("\n=== duplicate son dedupe ===\n");

const deduped = consolidateRowsRuleBased([
  {
    memory_type: "life_context",
    content: "У пользователя есть сын.",
  },
  {
    memory_type: "life_context",
    content: "У пользователя есть сын",
  },
  {
    memory_type: "life_context",
    content: "У пользователя есть собака Крис.",
  },
  {
    memory_type: "communication",
    content: "Прямо и по делу, без пустых слов.",
  },
]);
assert(deduped.length === 3, `expected 3 rows after dedupe, got ${deduped.length}`);
assert(
  deduped.filter((c) => c.memory_type === "life_context" && /сын/i.test(c.content)).length === 1,
  "one son row only"
);
assert(
  deduped.some((c) => c.memory_type === "life_context" && /крис/i.test(c.content)),
  "dog row retained"
);
assert(
  deduped.some((c) => c.memory_type === "communication" && /прям/i.test(c.content)),
  "communication row retained separately"
);
console.log("PASS: duplicate son collapsed, dog and communication kept");

console.log("\n=== seeded summary trace ===\n");

const seeded = mem({
  people: [
    "У пользователя есть сын",
    "У пользователя есть собака Крис",
    "Пользователь работает над приложением StaySee",
  ],
  preferences: [
    "Обращаться ко мне в женском роде",
    "Мне не нужны советы и пустые слова — нужно присутствие",
  ],
  important_events: [
    "Пользователь купила курс, но считает, что у преподавателя недостаточно компетенций",
    "Племянница с дипломом психолога создала пару с сыном пользователя",
  ],
  themes: ["Сегодня пользователь выбирает красный для яркости"],
});

const beforeFilter = buildCrossMemoryCandidates(seeded);
console.log(
  "rule-based after filter:",
  beforeFilter.map((c) => `[${c.memory_type}] ${c.content}`)
);
assert(beforeFilter.length >= 5, `seeded should yield >=5 rows, got ${beforeFilter.length}`);
assert(beforeFilter.some((c) => /сын/i.test(c.content)), "seeded son");
assert(
  beforeFilter.some((c) => /совет|присутств|женск/i.test(c.content)),
  "seeded communication"
);
console.log("PASS: seeded summary retains son + communication prefs");

console.log("\n=== crossMemoryRetention.cases.test.ts OK ===\n");
