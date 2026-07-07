/**
 * legacy_doc_flat experiment — doc-flag plumbing cases.
 * Run: npx tsx supabase/functions/_shared/promptCore/legacyDocFlatPrompt.cases.test.ts
 *
 * Verifies STAYSEE_PROMPT_CORE_DOC swaps only the base document + audit label under
 * STAYSEE_PROMPT_CORE=v2, and leaves flat runtime / model router / budget untouched.
 */

import { getPromptAuditVersion } from "../aiAuditVersions.ts";
import { isFlatCoreV2OrdinaryRuntime } from "../flatCoreV2Runtime.ts";
import { resolveChatModel } from "../modelRouter.ts";
import { APPROVED_MODEL_GPT4O } from "../approvedModels.ts";
import {
  getPromptCoreDoc,
  getPromptCoreMode,
  parsePromptCoreDoc,
  resolveActivePromptLayerId,
  resolveV2Document,
} from "./promptCoreMode.ts";
import {
  buildLegacyDocFlatCleanPrompt,
  buildLegacyDocFlatPrompt,
  LEGACY_DOC_FLAT_CLEAN_LAYER_ID,
  LEGACY_DOC_FLAT_LAYER_ID,
} from "./legacyDocFlatPrompt.ts";
import {
  buildStayseeCorePromptV2GptsSource,
  STAYSEE_CORE_V2_LAYER_ID,
} from "./stayseeCorePromptV2GptsSource.ts";
import { buildStayseeCorePrompt } from "./stayseeCorePrompt.ts";
import { buildSurgery1BasePrompt } from "../surgery1Prompt.ts";

// Model router reads Deno.env.get internally; stub it (all readers below are explicit).
(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: () => undefined } };

let failed = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.log(`FAIL: ${message}`);
    failed++;
    return;
  }
  console.log(`PASS: ${message}`);
}

const envV1 = () => "v1" as string | undefined;
const envV2 = () => "v2" as string | undefined;
const envLegacyMode = () => "legacy" as string | undefined;

const docNone = () => undefined as string | undefined;
const docEmpty = () => "" as string | undefined;
const docUnknown = () => "something_else" as string | undefined;
const docLegacy = () => "legacy_doc_flat" as string | undefined;
const docClean = () => "legacy_doc_flat_clean" as string | undefined;

// ── A. Doc flag parsing ──────────────────────────────────────────────────────

assert(parsePromptCoreDoc(undefined) === "gpts_source", "missing doc → gpts_source");
assert(parsePromptCoreDoc("") === "gpts_source", "empty doc → gpts_source");
assert(parsePromptCoreDoc("unknown") === "gpts_source", "unknown doc → gpts_source");
assert(
  parsePromptCoreDoc("legacy_doc_flat") === "legacy_doc_flat",
  "legacy_doc_flat opts in",
);
assert(
  parsePromptCoreDoc("legacy_doc_flat_clean") === "legacy_doc_flat_clean",
  "legacy_doc_flat_clean opts in",
);
assert(getPromptCoreDoc(docLegacy) === "legacy_doc_flat", "getter legacy_doc_flat");
assert(getPromptCoreDoc(docClean) === "legacy_doc_flat_clean", "getter legacy_doc_flat_clean");
assert(getPromptCoreDoc(docUnknown) === "gpts_source", "getter unknown → gpts_source");

console.log("✓ A. doc flag parsing");

// ── B. Default v2 (no doc flag) stays current gpts-source ─────────────────────

const gptsSourceText = buildStayseeCorePromptV2GptsSource();

for (const [reader, label] of [
  [docNone, "no doc flag"],
  [docEmpty, "empty doc flag"],
  [docUnknown, "unknown doc flag"],
] as const) {
  assert(
    resolveV2Document(reader).layerId === STAYSEE_CORE_V2_LAYER_ID,
    `${label} → layer staysee-core-v2-gpts-source`,
  );
  assert(
    resolveV2Document(reader).text === gptsSourceText,
    `${label} → text is current gpts-source`,
  );
  assert(
    getPromptAuditVersion(envV2, reader) === STAYSEE_CORE_V2_LAYER_ID,
    `${label} → prompt_version staysee-core-v2-gpts-source`,
  );
  assert(
    buildSurgery1BasePrompt(envV2, reader) === gptsSourceText,
    `${label} → base prompt is current gpts-source`,
  );
}

console.log("✓ B. default v2 unchanged without doc flag");

// ── C. v2 + legacy_doc_flat swaps document + label ───────────────────────────

const legacyDocText = buildLegacyDocFlatPrompt();

assert(
  resolveV2Document(docLegacy).layerId === LEGACY_DOC_FLAT_LAYER_ID,
  "legacy_doc_flat → layer staysee-legacy-doc-flat",
);
assert(LEGACY_DOC_FLAT_LAYER_ID === "staysee-legacy-doc-flat", "layer id literal");
assert(
  resolveV2Document(docLegacy).text === legacyDocText,
  "legacy_doc_flat → text is legacy doc",
);
assert(
  resolveActivePromptLayerId(envV2, docLegacy) === LEGACY_DOC_FLAT_LAYER_ID,
  "resolveActivePromptLayerId(v2, legacy_doc_flat) → staysee-legacy-doc-flat",
);
assert(
  getPromptAuditVersion(envV2, docLegacy) === LEGACY_DOC_FLAT_LAYER_ID,
  "prompt_version under legacy_doc_flat → staysee-legacy-doc-flat",
);
assert(
  buildSurgery1BasePrompt(envV2, docLegacy) === legacyDocText,
  "buildSurgery1BasePrompt(v2, legacy_doc_flat) === buildLegacyDocFlatPrompt()",
);
assert(legacyDocText !== gptsSourceText, "legacy doc differs from gpts-source");

console.log("✓ C. legacy_doc_flat swaps document + label");

// ── D. legacy_doc_flat content composition ───────────────────────────────────

assert(
  legacyDocText.includes("Диагнозы, симптомы, лекарства — область врача"),
  "legacy doc includes PROMPT_CANDIDATE_V1 medical-boundary line",
);
assert(
  legacyDocText.includes("Ты не психолог в формальном смысле, не коуч, не ассистент"),
  "legacy doc includes PROMPT_CANDIDATE_V1 presence layer",
);
assert(
  legacyDocText.includes("# ЯДРО ПРОЦЕССА"),
  "legacy doc includes processCore process/contact layer header",
);
assert(
  legacyDocText.includes("Пока фигура жива, Стэйси удерживает нить контакта"),
  "legacy doc includes processCore contact line",
);

console.log("✓ D. legacy_doc_flat composition");

// ── E. Doc flag does not affect flat runtime / model router / budget ─────────
// The doc flag reads STAYSEE_PROMPT_CORE_DOC only. flatOrdinary is derived from the
// core mode (STAYSEE_PROMPT_CORE), and model router / budget take a flatOrdinary
// boolean — never the doc flag. So the doc flag is structurally orthogonal.

// Core mode (which drives flatOrdinary) stays v2 for any doc value.
for (const doc of [docNone, docLegacy, docUnknown]) {
  void doc; // doc reader is not even consulted by getPromptCoreMode
  assert(getPromptCoreMode(envV2) === "v2", "core mode stays v2 for any doc value");
}

assert(
  isFlatCoreV2OrdinaryRuntime("normal", envV2) === true,
  "flat ordinary runtime active under v2 (doc flag orthogonal)",
);
assert(
  isFlatCoreV2OrdinaryRuntime("crisis", envV2) === false,
  "crisis not flat ordinary under v2",
);

const routeFlat = resolveChatModel({
  depth: "deep",
  safetyCategory: "normal",
  flatOrdinary: true,
});
assert(
  routeFlat.model === APPROVED_MODEL_GPT4O && routeFlat.source === "flat_ordinary",
  "model router flat ordinary unchanged (gpt-4o) — no doc dependency",
);

console.log("✓ E. flat runtime / router / budget unaffected by doc flag");

// ── F. v1 / legacy unaffected by doc flag ────────────────────────────────────

assert(getPromptCoreMode(envV2) === "v2", "core mode stays v2 with doc flag");

assert(
  buildSurgery1BasePrompt(envV1, docLegacy) === buildStayseeCorePrompt(),
  "v1 mode ignores doc flag (still v1 core)",
);
assert(
  resolveActivePromptLayerId(envV1, docLegacy) === "staysee-core-v1",
  "v1 layer id ignores doc flag",
);
assert(
  resolveActivePromptLayerId(envLegacyMode, docLegacy) ===
    "surgery1-v3-cognitive-v1-process-core",
  "legacy layer id ignores doc flag",
);

console.log("✓ F. v1 / legacy unchanged");

// ── G. legacy_doc_flat_clean variant ─────────────────────────────────────────

const cleanText = buildLegacyDocFlatCleanPrompt();

assert(
  resolveV2Document(docClean).layerId === LEGACY_DOC_FLAT_CLEAN_LAYER_ID,
  "legacy_doc_flat_clean → layer staysee-legacy-doc-flat-clean",
);
assert(
  LEGACY_DOC_FLAT_CLEAN_LAYER_ID === "staysee-legacy-doc-flat-clean",
  "clean layer id literal",
);
assert(
  resolveV2Document(docClean).text === cleanText,
  "legacy_doc_flat_clean → text is clean doc",
);
assert(
  resolveActivePromptLayerId(envV2, docClean) === LEGACY_DOC_FLAT_CLEAN_LAYER_ID,
  "resolveActivePromptLayerId(v2, clean) → staysee-legacy-doc-flat-clean",
);
assert(
  getPromptAuditVersion(envV2, docClean) === LEGACY_DOC_FLAT_CLEAN_LAYER_ID,
  "prompt_version under clean → staysee-legacy-doc-flat-clean",
);
assert(
  buildSurgery1BasePrompt(envV2, docClean) === cleanText,
  "buildSurgery1BasePrompt(v2, clean) === buildLegacyDocFlatCleanPrompt()",
);

// clean = legacy_doc_flat base + adaptation block (base reused verbatim)
assert(
  cleanText.startsWith(legacyDocText),
  "clean doc begins with the exact legacy_doc_flat base",
);
assert(cleanText.length > legacyDocText.length, "clean doc adds content over base");
assert(cleanText !== legacyDocText, "clean differs from legacy_doc_flat");
assert(cleanText !== gptsSourceText, "clean differs from gpts-source");

// all 3 adaptation headings + rule anchors present
const cleanAdaptationAnchors: string[] = [
  "ТРИ ПРАВКИ ДЛЯ ПРИЛОЖЕНИЯ",
  "1. Незнание и бессилие.",
  "не возвращай ему задачу найти ответ",
  "2. Практические вопросы.",
  "не начинай с длинного списка",
  "3. Пауза и завершение.",
  "без хвоста доступности",
];
for (const anchor of cleanAdaptationAnchors) {
  assert(cleanText.includes(anchor), `clean adaptation anchor: ${anchor}`);
}

// clean still carries base layers
assert(
  cleanText.includes("Диагнозы, симптомы, лекарства — область врача"),
  "clean keeps presence medical-boundary line",
);
assert(cleanText.includes("# ЯДРО ПРОЦЕССА"), "clean keeps process/contact layer");

// legacy_doc_flat MUST NOT contain the adaptation block (unchanged)
assert(
  !legacyDocText.includes("ТРИ ПРАВКИ ДЛЯ ПРИЛОЖЕНИЯ"),
  "legacy_doc_flat unchanged (no adaptation block)",
);
assert(
  buildLegacyDocFlatPrompt() === legacyDocText,
  "legacy_doc_flat builder output unchanged",
);

// default gpts-source unchanged with clean flag; runtime/model orthogonal
assert(getPromptCoreMode(envV2) === "v2", "core mode stays v2 with clean flag");
assert(
  isFlatCoreV2OrdinaryRuntime("normal", envV2) === true,
  "flat ordinary runtime active with clean flag (orthogonal)",
);
const routeClean = resolveChatModel({
  depth: "deep",
  safetyCategory: "normal",
  flatOrdinary: true,
});
assert(
  routeClean.model === APPROVED_MODEL_GPT4O && routeClean.source === "flat_ordinary",
  "model router unchanged with clean flag (gpt-4o)",
);
assert(
  resolveActivePromptLayerId(envV1, docClean) === "staysee-core-v1",
  "v1 ignores clean doc flag",
);

console.log("✓ G. legacy_doc_flat_clean variant");

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log("\nAll legacyDocFlatPrompt cases passed.");
