/**
 * Weekly reflection privacy — insight/tension must not enter generation input.
 * Run: npx tsx supabase/functions/_shared/weeklyReflection.cases.test.ts
 */

import { register } from "node:module";

// weeklyReflection.ts has a type-only `npm:` specifier for SupabaseClient --
// same remap as cost.cases.test.ts, so local tsx can load
// buildWeeklyReflectionPrompt without changing production code.
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier === "string" && specifier.startsWith("npm:")) {
    const rest = specifier.slice(4);
    const bare = rest.startsWith("@")
      ? "@" + rest.slice(1).split("@")[0]
      : rest.split("@")[0];
    return nextResolve(bare, context);
  }
  return nextResolve(specifier, context);
}
`)}`,
);

import {
  isWeeklyReflectionVisibleEntryType,
  WEEKLY_REFLECTION_USER_MARK_ENTRY_TYPE,
} from "./weeklyReflectionPrivacy.ts";

// Transitive Edge modules read Deno.env at import time; stub only for local tsx.
const g = globalThis as typeof globalThis & {
  Deno?: { env: { get: (key: string) => string | undefined } };
};
if (!g.Deno) {
  g.Deno = {
    env: {
      get() {
        return undefined;
      },
    },
  };
}

// Dynamic, not static -- static imports are hoisted above the register()
// call above, which would defeat the npm: remap for this one specifically.
const { buildWeeklyReflectionPrompt } = await import("./weeklyReflection.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

console.log("=== weekly reflection entry-type privacy ===\n");

assert(
  WEEKLY_REFLECTION_USER_MARK_ENTRY_TYPE === "note",
  "user mark entry type must be note"
);
assert(isWeeklyReflectionVisibleEntryType("note"), "note should be visible");
assert(!isWeeklyReflectionVisibleEntryType("insight"), "insight must be private");
assert(!isWeeklyReflectionVisibleEntryType("tension"), "tension must be private");
assert(!isWeeklyReflectionVisibleEntryType("weekly"), "weekly snapshot must not feed generation");
assert(!isWeeklyReflectionVisibleEntryType("shift"), "shift must not feed generation");
assert(!isWeeklyReflectionVisibleEntryType("step"), "step must not feed generation");

console.log("All weeklyReflection privacy cases passed.");

console.log("\n=== buildWeeklyReflectionPrompt linked-pairs block ===\n");

const withPairs = buildWeeklyReflectionPrompt({
  title: "эта беседа", memory: null, transcript: [], userMarks: [], activeDays: 1,
  linkedPairs: [{ newClaim: "сменила работу", oldClaim: "боялась сменить работу" }],
});
assert(withPairs.includes("сменила работу"), "should include the new claim");
assert(withPairs.includes("боялась сменить работу"), "should include the old claim");
assert(/на ваше усмотрение/i.test(withPairs), "should leave attribution to the model's judgment");

const withoutPairs = buildWeeklyReflectionPrompt({
  title: "эта беседа", memory: null, transcript: [], userMarks: [], activeDays: 1,
  linkedPairs: [],
});
assert(!withoutPairs.includes("ПЕРЕМЕНЫ"), "should omit the block entirely when no pairs are passed");

console.log("All buildWeeklyReflectionPrompt linked-pairs cases passed.");
