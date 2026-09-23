/**
 * AI audit version labels + default field shape (no Deno/npm deps).
 * Run: npx tsx supabase/functions/_shared/usageAnalytics.cases.test.ts
 */

import {
  AI_AUDIT_COGNITIVE_SIGNATURE_VERSION,
  AI_AUDIT_CONSTITUTION_VERSION,
  AI_AUDIT_MEMORY_VERSION,
  AI_AUDIT_PROMPT_VERSION,
} from "./aiAuditVersions.ts";

// usageAnalytics.ts pulls in cost.ts, which imports the real "npm:" Supabase
// client -- Deno-only, unresolvable under plain Node/tsx. So this file can't
// import usageAnalytics.ts directly (see applyAuditDefaults above, which
// mirrors the same file for the same reason). This mirrors
// logMemoryV3LifecycleUsage's row-shaping instead.
function mirrorMemoryV3LifecycleUsageRow(input: {
  runId: string;
  stage: "extractor" | "reconciler";
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
}): Record<string, unknown> {
  return {
    cost: input.costUsd,
    prompt_tokens: input.promptTokens,
    completion_tokens: input.completionTokens,
    call_kind: input.stage === "extractor"
      ? "memory_lifecycle_extractor"
      : "memory_lifecycle_reconciler",
    request_id: input.runId,
  };
}

/** Mirrors buildUsageLogRow audit defaults in usageAnalytics.ts */
function applyAuditDefaults(
  audit: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    requestId: audit.requestId ?? null,
    finishReason: audit.finishReason ?? null,
    latencyMs: audit.latencyMs ?? null,
    wasTruncated: audit.wasTruncated ?? false,
    autoContinueUsed: audit.autoContinueUsed ?? false,
    finalizeUsed: audit.finalizeUsed ?? false,
    promptVersion: audit.promptVersion ?? null,
    constitutionVersion: audit.constitutionVersion ?? null,
    cognitiveSignatureVersion: audit.cognitiveSignatureVersion ?? null,
    memoryVersion: audit.memoryVersion ?? null,
    errorCode: audit.errorCode ?? null,
    errorMessage: audit.errorMessage ?? null,
    generationStatus: audit.generationStatus ?? null,
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const legacy = applyAuditDefaults();
assert(legacy.requestId === null, "legacy: requestId null");
assert(legacy.generationStatus === null, "legacy: generationStatus null");
assert(legacy.wasTruncated === false, "legacy: wasTruncated false");
assert(legacy.errorMessage === null, "legacy: errorMessage null");

const audited = applyAuditDefaults({
  requestId: "smoke-req-001",
  generationStatus: "success",
  promptVersion: AI_AUDIT_PROMPT_VERSION,
  autoContinueUsed: true,
});
assert(audited.requestId === "smoke-req-001", "audited: requestId");
assert(audited.generationStatus === "success", "audited: generationStatus");
assert(audited.autoContinueUsed === true, "audited: autoContinueUsed");

for (const label of [
  AI_AUDIT_PROMPT_VERSION,
  AI_AUDIT_CONSTITUTION_VERSION,
  AI_AUDIT_COGNITIVE_SIGNATURE_VERSION,
  AI_AUDIT_MEMORY_VERSION,
]) {
  assert(label.length < 80, `version label too long: ${label}`);
  assert(!label.includes("Стэйси"), `no prompt text in label: ${label}`);
  assert(!label.includes("# STAYSEE"), `no prompt text in label: ${label}`);
}

/**
 * Mirrors buildUsageLogRow's costCategory default in usageAnalytics.ts
 * (`input.costCategory ?? "automatic"`) -- same reason this file can't
 * import usageAnalytics.ts directly, see the comment above.
 */
function mirrorCostCategory(
  costCategory?: "automatic" | "technical"
): "automatic" | "technical" {
  return costCategory ?? "automatic";
}

assert(
  mirrorCostCategory() === "automatic",
  "costCategory defaults to automatic when the caller does not specify one"
);
assert(
  mirrorCostCategory("technical") === "technical",
  "costCategory respects an explicit technical value"
);

const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const extractorRow = mirrorMemoryV3LifecycleUsageRow({
  runId: RUN_ID, stage: "extractor", costUsd: 0.00034, promptTokens: 500, completionTokens: 120,
});
assert(extractorRow.call_kind === "memory_lifecycle_extractor", "extractor call_kind");
assert(extractorRow.request_id === RUN_ID, "extractor request_id reuses runId");
assert(extractorRow.cost === 0.00034, "extractor keeps the real reported cost");

const reconcilerRow = mirrorMemoryV3LifecycleUsageRow({
  runId: RUN_ID, stage: "reconciler", costUsd: 0.00061, promptTokens: 900, completionTokens: 200,
});
assert(reconcilerRow.call_kind === "memory_lifecycle_reconciler", "reconciler call_kind");
assert(reconcilerRow.request_id === RUN_ID, "reconciler request_id reuses runId");
assert(
  extractorRow.request_id === reconcilerRow.request_id,
  "both stages of one check share request_id, so count(DISTINCT request_id) counts checks"
);

console.log("usageAnalytics.cases.test.ts — all passed");
