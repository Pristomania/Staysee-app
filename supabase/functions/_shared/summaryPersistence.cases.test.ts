/**
 * Run: npx tsx supabase/functions/_shared/summaryPersistence.cases.test.ts
 */

import { readFileSync } from "node:fs";

function isSummaryTimestampColumnError(message: string | undefined): boolean {
  if (!message) return false;
  return /summary_updated_at/i.test(message);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const cases: Array<[string, boolean]> = [
  [
    "Could not find the 'summary_updated_at' column of 'conversations' in the schema cache",
    true,
  ],
  ["column conversations.summary_updated_at does not exist", true],
  ["permission denied for table conversations", false],
  [undefined as unknown as string, false],
];

for (const [message, expected] of cases) {
  assert(
    isSummaryTimestampColumnError(message) === expected,
    `isSummaryTimestampColumnError(${JSON.stringify(message)}) expected ${expected}`
  );
}

const memorySource = readFileSync(new URL("./memory.ts", import.meta.url), "utf8");
assert(
  memorySource.includes("postSaveSummaryUpdatedAt: postSummaryUpdatedAt"),
  "summary diagnostics must pass the declared post-save timestamp variable",
);

console.log("=== summaryPersistence.cases.test.ts OK ===\n");
