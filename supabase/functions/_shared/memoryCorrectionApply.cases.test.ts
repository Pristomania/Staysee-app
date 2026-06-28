/**
 * Run: npx tsx supabase/functions/_shared/memoryCorrectionApply.cases.test.ts
 */

import {
  applyDurableCorrections,
  crossMemoryContradictsCorrection,
  itemMatchesDeleteTarget,
  normalizeForDeleteMatch,
} from "./memoryCorrectionApply.ts";
import { MEMORY_CORRECTION_SUBJECTS } from "./memoryCorrectionSubjects.ts";
import type { MemoryCorrectionStructuredMemory } from "./memoryCorrectionApply.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function baseMemory(): MemoryCorrectionStructuredMemory {
  return {
    people: ["Партнёр — живут вместе"],
    themes: [],
    emotional_state: [],
    important_events: ["Живут вместе в одной квартире"],
    preferences: [],
    risks: [],
    open_loops: [],
    last_updated: new Date().toISOString(),
  };
}

console.log("=== memory correction apply ===\n");

const corrected = applyDurableCorrections(baseMemory(), [
  {
    subject_key: MEMORY_CORRECTION_SUBJECTS.cohabitation,
    correction_text: "Нет, мы не живём вместе, мы живём отдельно",
    display_text: "Живём отдельно, не вместе",
    scope: "conversation",
  },
]);

const joined = JSON.stringify(corrected).toLowerCase();
assert(!joined.includes("живут вместе"), "cohabitation fact removed");
assert(
  corrected.important_events.some((e) => /отдельно|раздельн|не вместе/i.test(e)),
  "correction line present"
);
console.log("PASS: apply removes contradicted cohabitation fact");

const mergeResurrect = applyDurableCorrections(
  {
    ...corrected,
    people: [...corrected.people, "Партнёр — живут вместе"],
    important_events: [...corrected.important_events, "Снова живут вместе"],
  },
  [
    {
      subject_key: MEMORY_CORRECTION_SUBJECTS.cohabitation,
      correction_text: "Нет, мы не живём вместе",
      display_text: "Живём отдельно",
      scope: "conversation",
    },
  ]
);
assert(
  !JSON.stringify(mergeResurrect).toLowerCase().includes("живут вместе"),
  "merge cannot resurrect cohabitation"
);
console.log("PASS: merge re-add blocked by durable correction");

const crossBlocked = crossMemoryContradictsCorrection(
  "Партнёр живёт вместе с пользователем",
  [
    {
      subject_key: MEMORY_CORRECTION_SUBJECTS.cohabitation,
      correction_text: "живём отдельно",
      display_text: "Живём отдельно",
      scope: "conversation",
    },
  ]
);
assert(crossBlocked, "cross-memory candidate suppressed");
console.log("PASS: cross-memory contradiction filter");

const deleteFactMemory: MemoryCorrectionStructuredMemory = {
  people: ["Партнёр — живут вместе"],
  themes: ["быт вместе"],
  emotional_state: [],
  important_events: ["Мы живём вместе уже год"],
  preferences: ["любит утренний кофе"],
  risks: [],
  open_loops: ["обсудить отпуск"],
  last_updated: new Date().toISOString(),
};

const deleteCorrection = {
  subject_key: MEMORY_CORRECTION_SUBJECTS.deleteFact,
  correction_text: "удали из памяти: мы живём вместе",
  display_text: "Удалено: мы живём вместе",
  old_text: "мы живём вместе",
  scope: "conversation" as const,
};

const afterDelete = applyDurableCorrections(deleteFactMemory, [deleteCorrection]);
assert(
  !afterDelete.important_events.some((e) =>
    normalizeForDeleteMatch(e).includes(normalizeForDeleteMatch("мы живём вместе"))
  ),
  "delete_fact removes important_events containing target phrase"
);
assert(
  !afterDelete.people.some((p) =>
    normalizeForDeleteMatch(p).includes(normalizeForDeleteMatch("мы живём вместе"))
  ),
  "delete_fact removes people lines containing target phrase"
);
assert(afterDelete.themes.includes("быт вместе"), "delete_fact keeps themes without target substring");
assert(
  afterDelete.preferences.includes("любит утренний кофе"),
  "delete_fact preserves unrelated preferences"
);
assert(
  afterDelete.open_loops.includes("обсудить отпуск"),
  "delete_fact preserves unrelated open_loops"
);
console.log("PASS: delete_fact strips phrase across structured fields");

const mergeResurrectDelete = applyDurableCorrections(
  {
    ...afterDelete,
    important_events: ["Мы живём вместе снова"],
    themes: ["быт вместе"],
  },
  [deleteCorrection]
);
assert(
  !mergeResurrectDelete.important_events.some((e) =>
    normalizeForDeleteMatch(e).includes(normalizeForDeleteMatch("мы живём вместе"))
  ),
  "merge cannot resurrect delete_fact target"
);
console.log("PASS: merge re-add blocked by delete_fact correction");

assert(
  itemMatchesDeleteTarget('«Мы   ЖИВЁМ   вместе»', "мы живем вместе"),
  "Cyrillic quotes/case/ё normalization"
);
assert(
  normalizeForDeleteMatch('  "мы   живем   вместе"  ') === "мы живем вместе",
  "normalize trims punctuation and spaces"
);
console.log("PASS: delete_fact Cyrillic normalization");

console.log("\nAll memoryCorrectionApply cases passed.");
