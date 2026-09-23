/**
 * Real-import coverage for buildUsageLogRow's costCategory default.
 *
 * usageAnalytics.cases.test.ts (tsx-based) can't import usageAnalytics.ts
 * directly -- it transitively pulls a value-level `npm:@supabase/supabase-js@2`
 * import (via cost.ts) that Node/tsx's ESM loader rejects
 * (ERR_UNSUPPORTED_ESM_URL_SCHEME), so that file mirrors the default logic in
 * a local helper instead of exercising the real function. Deno resolves
 * `npm:` specifiers natively, so this file imports the real
 * buildUsageLogRow and calls it directly, closing that gap: a future change
 * to the actual default (e.g. flipping `?? "automatic"` to `?? "technical"`)
 * will fail this test, whereas it would not fail the tsx mirror test or
 * `deno check` (both costCategory values are valid UsageCostCategory
 * members, so a swapped default is not a type error).
 *
 * Run:
 *   "/c/Users/Я/.deno/bin/deno.exe" test --no-check --allow-env=STAYSEE_EMBEDDING_MODEL \
 *     --no-config --node-modules-dir=none \
 *     supabase/functions/_shared/usageAnalytics.deno.test.ts
 *
 * --no-check: skips type-checking this file's whole import tree, which has
 * 23 pre-existing, unrelated type errors elsewhere (see Task 4's
 * deno-check baseline comparison) -- this test's job is runtime behavior,
 * not types, and `deno check` already covers types separately.
 * --allow-env=STAYSEE_EMBEDDING_MODEL: embeddings.ts (pulled in transitively)
 * reads this env var at import time.
 */
import { buildUsageLogRow } from "./usageAnalytics.ts";

Deno.test("buildUsageLogRow defaults costCategory to automatic when unspecified", () => {
  const row = buildUsageLogRow({
    userId: "11111111-1111-4111-8111-111111111111",
    model: "google/gemini-3.7-flash",
    promptTokens: 10,
    completionTokens: 5,
    memoryTokens: 0,
    summaryTokens: 0,
  });
  if (row.costCategory !== "automatic") {
    throw new Error(`expected automatic, got ${row.costCategory}`);
  }
});

Deno.test("buildUsageLogRow respects an explicit technical costCategory", () => {
  const row = buildUsageLogRow({
    userId: "11111111-1111-4111-8111-111111111111",
    model: "google/gemini-3.7-flash",
    promptTokens: 10,
    completionTokens: 5,
    memoryTokens: 0,
    summaryTokens: 0,
    costCategory: "technical",
  });
  if (row.costCategory !== "technical") {
    throw new Error(`expected technical, got ${row.costCategory}`);
  }
});
