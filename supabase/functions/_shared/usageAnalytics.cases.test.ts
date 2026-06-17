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

console.log("usageAnalytics.cases.test.ts — all passed");
