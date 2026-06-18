/**
 * sessionProcessState — PR3c-1 unit cases.
 * Run: npx tsx supabase/functions/_shared/sessionProcessState.cases.test.ts
 */

import { computeProcessState } from "./processState.ts";
import {
  buildLegacySessionProcessState,
  buildProcessStateMetadataPatch,
  buildStructuredSessionProcessState,
  extractSessionProcessStateFromMetadata,
  parseSessionProcessState,
  type SessionProcessState,
} from "./sessionProcessState.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const ISO = "2026-06-18T12:00:00.000Z";

const validLegacy = {
  contact: "active" as const,
  movement: "opening" as const,
  closure: "none" as const,
  certainty: "low" as const,
  source: "legacy_shadow" as const,
  updatedAt: ISO,
};

const validStructured = {
  contact: "reduced" as const,
  movement: "stuck" as const,
  closure: "system_should_not_close" as const,
  certainty: "medium" as const,
  source: "structured_shadow" as const,
  updatedAt: ISO,
};

// 1. valid legacy state
assert(
  parseSessionProcessState(validLegacy)?.contact === "active",
  "valid legacy state"
);
console.log("PASS: valid legacy state");

// 2. valid structured state
assert(
  parseSessionProcessState(validStructured)?.source === "structured_shadow",
  "valid structured state"
);
console.log("PASS: valid structured state");

// 3. invalid enum rejected
assert(
  parseSessionProcessState({ ...validLegacy, contact: "invalid" }) === null,
  "invalid enum rejected"
);
console.log("PASS: invalid enum rejected");

// 4. extra fields dropped (rejected)
assert(
  parseSessionProcessState({ ...validLegacy, extra: "x" }) === null,
  "extra fields rejected"
);
console.log("PASS: extra fields dropped");

// 5. forbidden fields dropped
assert(
  parseSessionProcessState({ ...validLegacy, reasoning: "user said pity" }) === null,
  "forbidden fields rejected"
);
console.log("PASS: forbidden fields dropped");

// 6. legacy source
const legacyBuilt = buildLegacySessionProcessState(
  computeProcessState({
    openFigure: { isOpen: true, intensity: "low", confidence: "low" },
    depth: "medium",
    explicitClosure: false,
    uncertainty: false,
    recentUserTurns: 2,
    safetyCategory: "normal",
  })
);
assert(legacyBuilt.source === "legacy_shadow", "legacy source");
console.log("PASS: legacy source");

// 7. structured source
const structuredBuilt = buildStructuredSessionProcessState({
  contact: "active",
  movement: "deepening",
  closure: "none",
  certainty: "high",
});
assert(structuredBuilt.source === "structured_shadow", "structured source");
console.log("PASS: structured source");

// 8. metadata extraction
const extracted = extractSessionProcessStateFromMetadata({
  processState: validLegacy,
  processStateStructured: validStructured,
});
assert(extracted.legacy?.movement === "opening", "metadata extraction legacy");
assert(extracted.structured?.movement === "stuck", "metadata extraction structured");
console.log("PASS: metadata extraction");

// 9. invalid metadata ignored
const bad = extractSessionProcessStateFromMetadata({
  processState: { ...validLegacy, contact: "nope" },
});
assert(bad.legacy === null, "invalid metadata ignored");
console.log("PASS: invalid metadata ignored");

// 10. metadata patch allowed keys only
const patched = buildProcessStateMetadataPatch(
  { processState: validLegacy, processStateStructured: validStructured, futureKey: "keep" },
  { processState: { ...validLegacy, movement: "deepening" } }
);
assert(
  (patched.processState as SessionProcessState).movement === "deepening",
  "patch updates legacy"
);
assert(
  (patched.processStateStructured as { movement: string }).movement === "stuck",
  "patch preserves structured"
);
assert(patched.futureKey === "keep", "patch preserves unrelated metadata keys");
console.log("PASS: metadata patch allowed keys only");

// 11. no raw text in patch
const rawRejected = parseSessionProcessState({
  ...validLegacy,
  contact: "Пользователь сказал жалость к ней",
});
assert(rawRejected === null, "no raw text in patch");
console.log("PASS: no raw text in patch");

// 12. updatedAt default ISO
const withDefault = buildStructuredSessionProcessState({
  contact: "active",
  movement: "opening",
  closure: "none",
  certainty: "low",
});
assert(
  Number.isFinite(Date.parse(withDefault.updatedAt)),
  "updatedAt default ISO"
);
console.log("PASS: updatedAt default ISO");

// N-1: patch without structured update preserves prior structured
const preserveStructured = buildProcessStateMetadataPatch(
  { processState: validLegacy, processStateStructured: validStructured },
  { processState: { ...validLegacy, certainty: "high" } }
);
assert(
  (preserveStructured.processStateStructured as SessionProcessState).certainty === "medium",
  "N-1 structured preserved when not in patch"
);
console.log("PASS: N-1 structured preserved on legacy-only patch");

console.log("\nAll sessionProcessState cases passed.");
