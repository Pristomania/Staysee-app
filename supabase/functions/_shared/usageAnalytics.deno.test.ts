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

// ── The four memory call kinds reach the usage table with their cost (added 20.11.2026) ──────────────────────────────────
// The union UsageCallKind lacked the two dialogue kinds, which `deno check` reported; fixing the union alone does not show
// that the money of those calls is recorded. These tests run the real logMemoryV3LifecycleUsage against a recording client.
import { logMemoryV3LifecycleUsage } from "./usageAnalytics.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

function recordingClient(result: { error: { message: string } | null } = { error: null }) {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const client = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, row });
        return Promise.resolve(result);
      },
    }),
  } as unknown as SupabaseClient;
  return { client, inserted };
}

const STAGES: Array<{
  pipeline: "dialogue" | "lifecycle";
  stage: "extractor" | "reconciler";
  expectedKind: string;
}> = [
  { pipeline: "dialogue", stage: "extractor", expectedKind: "memory_dialogue_extractor" },
  { pipeline: "dialogue", stage: "reconciler", expectedKind: "memory_dialogue_reconciler" },
  { pipeline: "lifecycle", stage: "extractor", expectedKind: "memory_lifecycle_extractor" },
  { pipeline: "lifecycle", stage: "reconciler", expectedKind: "memory_lifecycle_reconciler" },
];

for (const { pipeline, stage, expectedKind } of STAGES) {
  Deno.test(`logMemoryV3LifecycleUsage records ${expectedKind} with its cost and run id`, async () => {
    const { client, inserted } = recordingClient();
    await logMemoryV3LifecycleUsage(client, {
      userId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      runId: "run-fixture-1",
      stage,
      model: "fake/model",
      promptTokens: 120,
      completionTokens: 30,
      costUsd: 0.0123,
      pipeline,
    });
    if (inserted.length !== 1) throw new Error(`expected one usage row, got ${inserted.length}`);
    const { table, row } = inserted[0]!;
    if (table !== "ai_usage_logs") throw new Error(`written to ${table}`);
    if (row.call_kind !== expectedKind) throw new Error(`call_kind ${String(row.call_kind)}, expected ${expectedKind}`);
    if (row.cost !== 0.0123) throw new Error(`cost ${String(row.cost)}`);
    if (row.request_id !== "run-fixture-1") throw new Error(`request_id ${String(row.request_id)}`);
    if (row.cost_category !== "automatic") throw new Error(`cost_category ${String(row.cost_category)}`);
    if (row.prompt_tokens !== 120 || row.completion_tokens !== 30) throw new Error("token counts lost");
  });
}

Deno.test("a failed usage insert is logged and does not break the memory run", async () => {
  const { client } = recordingClient({ error: { message: "insert failed (fixture)" } });
  await logMemoryV3LifecycleUsage(client, {
    userId: "11111111-1111-4111-8111-111111111111",
    conversationId: "22222222-2222-4222-8222-222222222222",
    runId: "run-fixture-2",
    stage: "extractor",
    model: "fake/model",
    promptTokens: 1,
    completionTokens: 1,
    costUsd: 0.001,
    pipeline: "dialogue",
  });
});
