/**
 * Empty summary shell guard tests (pure — no Deno/npm imports).
 * Run: npx tsx supabase/functions/_shared/memoryEmptyGuard.cases.test.ts
 */

type Mem = {
  people: string[];
  themes: string[];
  emotional_state: string[];
  important_events: string[];
  preferences: string[];
  risks: string[];
  open_loops: string[];
  last_updated: string;
};

const FIELDS: (keyof Omit<Mem, "last_updated">)[] = [
  "people",
  "themes",
  "emotional_state",
  "important_events",
  "preferences",
  "risks",
  "open_loops",
];

function emptyMem(): Mem {
  return {
    people: [],
    themes: [],
    emotional_state: [],
    important_events: [],
    preferences: [],
    risks: [],
    open_loops: [],
    last_updated: new Date().toISOString(),
  };
}

function hasContent(mem: Mem | null): boolean {
  if (!mem) return false;
  return FIELDS.some((f) => mem[f].length > 0);
}

function serializeMem(mem: Mem): string {
  return JSON.stringify({ ...mem, last_updated: mem.last_updated || new Date().toISOString() });
}

function parseMem(raw: string | null | undefined): Mem | null {
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw) as Mem;
  } catch {
    return null;
  }
}

function isTrivialEmpty(raw: string | null | undefined): boolean {
  const p = parseMem(raw);
  if (!p) return false;
  return !hasContent(p);
}

function isEffectivelyEmpty(mem: Mem | null | undefined): boolean {
  if (!mem) return true;
  return !hasContent(mem);
}

function evaluateSaveCandidate(input: {
  previousRaw: string | null;
  candidate: Mem;
  allowEmptyMemory?: boolean;
}): { allowed: boolean; reason?: string } {
  if (input.allowEmptyMemory) return { allowed: true };
  if (hasContent(input.candidate)) return { allowed: true };
  const previousMeaningful =
    !!input.previousRaw?.trim() && !isTrivialEmpty(input.previousRaw);
  if (previousMeaningful) {
    return { allowed: false, reason: "empty_summary_guard" };
  }
  return { allowed: false, reason: "empty_summary_candidate" };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const EMPTY_SHELL = serializeMem(emptyMem());
const NON_EMPTY_PREVIOUS = serializeMem({
  ...emptyMem(),
  themes: ["работа и усталость"],
  people: ["Аня"],
});

console.log("=== isStructuredMemoryEffectivelyEmpty ===\n");

assert(isEffectivelyEmpty(emptyMem()), "empty struct");
assert(isEffectivelyEmpty(null), "null struct");
assert(
  !isEffectivelyEmpty({
    ...emptyMem(),
    open_loops: ["нужно поговорить с мамой"],
  }),
  "open_loops non-empty"
);
assert(isTrivialEmpty(EMPTY_SHELL), "trivial empty summary");
assert(!isTrivialEmpty(NON_EMPTY_PREVIOUS), "non-empty previous");
console.log("PASS: empty helper detects shell and non-empty fields");

console.log("\n=== evaluateSummarySaveCandidate ===\n");

const blockOverwrite = evaluateSaveCandidate({
  previousRaw: NON_EMPTY_PREVIOUS,
  candidate: emptyMem(),
});
assert(
  !blockOverwrite.allowed && blockOverwrite.reason === "empty_summary_guard",
  "block empty overwrite"
);

const allowDeleteFact = evaluateSaveCandidate({
  previousRaw: NON_EMPTY_PREVIOUS,
  candidate: emptyMem(),
  allowEmptyMemory: true,
});
assert(allowDeleteFact.allowed, "delete_fact allowEmptyMemory");
console.log("PASS: overwrite guard and delete_fact exception");

const blockEmptyCandidate = evaluateSaveCandidate({
  previousRaw: null,
  candidate: emptyMem(),
});
assert(
  !blockEmptyCandidate.allowed &&
    blockEmptyCandidate.reason === "empty_summary_candidate",
  "block empty candidate with no previous"
);

const allowGoodCandidate = evaluateSaveCandidate({
  previousRaw: NON_EMPTY_PREVIOUS,
  candidate: { ...emptyMem(), themes: ["новая тема"] },
});
assert(allowGoodCandidate.allowed, "allow non-empty candidate");
console.log("PASS: candidate validation");

console.log("\n=== forced empty cannot pass save guard ===\n");

assert(
  evaluateSaveCandidate({
    previousRaw: NON_EMPTY_PREVIOUS,
    candidate: emptyMem(),
  }).allowed === false,
  "forced empty blocked when previous non-empty"
);

console.log("\n=== chunk empty shell filter ===\n");

assert(isTrivialEmpty(EMPTY_SHELL), "empty chunk filtered");
assert(!isTrivialEmpty(NON_EMPTY_PREVIOUS), "non-empty chunk kept");
console.log("PASS: chunk filter");

console.log("\n=== memoryEmptyGuard.cases.test.ts OK ===\n");
