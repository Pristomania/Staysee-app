/**
 * Weekly reflection privacy — insight/tension must not enter generation input.
 * Run: npx tsx supabase/functions/_shared/weeklyReflection.cases.test.ts
 */

import {
  isWeeklyReflectionVisibleEntryType,
  WEEKLY_REFLECTION_USER_MARK_ENTRY_TYPE,
} from "./weeklyReflectionPrivacy.ts";

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
