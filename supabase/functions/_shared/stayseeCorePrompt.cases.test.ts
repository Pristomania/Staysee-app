/**
 * StaySee prompt core v1 — unit cases.
 * Run: npx tsx supabase/functions/_shared/stayseeCorePrompt.cases.test.ts
 */

import { getPromptAuditVersion } from "./aiAuditVersions.ts";
import {
  getPromptCoreMode,
  parsePromptCoreMode,
  resolveActivePromptLayerId,
} from "./promptCore/promptCoreMode.ts";
import {
  buildStayseeCorePrompt,
  STAYSEE_CORE_LAYER_ID,
} from "./promptCore/stayseeCorePrompt.ts";
import {
  buildStayseeCorePromptV2GptsSource,
  STAYSEE_CORE_V2_LAYER_ID,
} from "./promptCore/stayseeCorePromptV2GptsSource.ts";
import {
  buildLegacySurgery1BasePrompt,
  buildSurgery1BasePrompt,
  SURGERY1_BLOCKS,
  SURGERY1_LAYER_ID,
} from "./surgery1Prompt.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const envMissing = () => undefined;
const envEmpty = () => "" as string | undefined;
const envInvalid = () => "unknown" as string | undefined;
const envLegacy = () => "legacy" as string | undefined;
const envV1 = () => "v1" as string | undefined;
const envV2 = () => "v2" as string | undefined;

// ── A. Default legacy ────────────────────────────────────────────────────────

assert(parsePromptCoreMode(undefined) === "legacy", "missing env → legacy");
assert(parsePromptCoreMode("") === "legacy", "empty env → legacy");
assert(parsePromptCoreMode("invalid") === "legacy", "invalid env → legacy");
assert(parsePromptCoreMode("legacy") === "legacy", "legacy env → legacy");
assert(getPromptCoreMode(envMissing) === "legacy", "getter missing → legacy");
assert(getPromptCoreMode(envEmpty) === "legacy", "getter empty → legacy");
assert(getPromptCoreMode(envInvalid) === "legacy", "getter invalid → legacy");

const legacyDefault = buildSurgery1BasePrompt(envMissing);
const legacyExplicit = buildLegacySurgery1BasePrompt();
assert(legacyDefault === legacyExplicit, "default buildSurgery1BasePrompt === buildLegacySurgery1BasePrompt");

assert(
  !legacyDefault.includes("# STAYSEE CORE V1"),
  "default output must not contain STAYSEE CORE V1 header"
);
assert(
  resolveActivePromptLayerId(envMissing) === SURGERY1_LAYER_ID,
  "default layer id = SURGERY1_LAYER_ID"
);
assert(
  getPromptAuditVersion(envMissing) === SURGERY1_LAYER_ID,
  "default audit version = SURGERY1_LAYER_ID"
);

console.log("✓ A. default legacy parity");

// ── B. Flag v1 ───────────────────────────────────────────────────────────────

assert(parsePromptCoreMode("v1") === "v1", "v1 env → v1");
assert(getPromptCoreMode(envV1) === "v1", "getter v1 → v1");

const v1Prompt = buildSurgery1BasePrompt(envV1);
const v1Direct = buildStayseeCorePrompt();
assert(v1Prompt === v1Direct, "v1 flag routes to buildStayseeCorePrompt");
assert(
  resolveActivePromptLayerId(envV1) === STAYSEE_CORE_LAYER_ID,
  "v1 layer id = staysee-core-v1"
);
assert(
  getPromptAuditVersion(envV1) === STAYSEE_CORE_LAYER_ID,
  "v1 audit version = staysee-core-v1"
);
assert(v1Prompt.includes("# STAYSEE CORE V1"), "v1 contains core header");

const invariants: Array<[RegExp, string]> = [
  [/не на стороне того как он уходит от себя/i, "not fixing / not siding with avoidance"],
  [/разговор не закрывается пока человек сам/i, "process not closed by Stacey"],
  [/пауза — не закрытие разговора/i, "pause is not closure"],
  [/следующий ход не обязательно вопрос/i, "next move not necessarily question"],
  [/живое закрывается тёплой фразой/i, "softness must not close live figure"],
  [/стэйси не подводит итог разговора первой/i, "no unsolicited summary"],
  [/не availability-хвостом/i, "no availability tail principle"],
];

for (const [re, label] of invariants) {
  assert(re.test(v1Prompt), `v1 invariant missing: ${label}`);
}

const summaryRequestGuards: Array<[RegExp | ((text: string) => boolean), string]> = [
  [/если пользователь прямо просит итог/i, "explicit permission for user-requested summary"],
  [/если материала для итога нет/i, "direct no-material handling"],
  [
    (text) => !/итог не подводится пока[\s\S]*или прямо не попросил/i.test(text),
    "no confusing double-negative summary wording",
  ],
  [/или попросил об этом/i, "contact-break explicit-request exception"],
];

for (const [check, label] of summaryRequestGuards) {
  const ok = typeof check === "function" ? check(v1Prompt) : check.test(v1Prompt);
  assert(ok, `v1 summary-request guard missing: ${label}`);
}

console.log("✓ B2. summary-request wording guards");

const identityGuards: Array<[RegExp | ((text: string) => boolean), string]> = [
  [/у тебя психологическая основа/i, "psychological foundation in identity"],
  [
    /умеешь присутствовать внутри того, что происходит с человеком/i,
    "presence inside what happens with the person",
  ],
  [
    (text) => !/не\s+психолог\s+в\s+формальном\s+смысле/i.test(text),
    "old identity negation: not formal psychologist",
  ],
  [(text) => !/не\s+коуч/i.test(text), "old identity negation: not coach"],
  [(text) => !/не\s+ассистент/i.test(text), "old identity negation: not assistant"],
];

for (const [check, label] of identityGuards) {
  const ok = typeof check === "function" ? check(v1Prompt) : check.test(v1Prompt);
  assert(ok, `v1 identity guard missing: ${label}`);
}

console.log("✓ B3. identity wording guards");

console.log("✓ B. flag v1 invariants");

// ── C. Compatibility ─────────────────────────────────────────────────────────

assert(SURGERY1_LAYER_ID === "surgery1-v3-cognitive-v1-process-core", "SURGERY1_LAYER_ID unchanged");
assert(typeof SURGERY1_BLOCKS.identity === "string", "SURGERY1_BLOCKS.identity available");
assert(typeof SURGERY1_BLOCKS.processCore === "string", "SURGERY1_BLOCKS.processCore available");
assert(typeof SURGERY1_BLOCKS.voice === "string", "SURGERY1_BLOCKS.voice available");

assert(
  legacyDefault.includes("# ЯДРО ПРОЦЕССА"),
  "legacy contains process core marker"
);
assert(
  legacyDefault.includes("# STAYSEE AI — VOICE V3"),
  "legacy contains voice v3 marker"
);
assert(
  legacyDefault.includes("# STAYSEE AI — CONSTITUTION V3 BETA"),
  "legacy contains constitution marker"
);

assert(
  !v1Prompt.includes("# STAYSEE AI — VOICE V3"),
  "v1 must not include legacy VOICE V3 section header"
);
assert(
  !v1Prompt.includes("# STAYSEE AI — CONSTITUTION V3 BETA"),
  "v1 must not include legacy constitution section header"
);
assert(
  !v1Prompt.includes("# STAYSEE AI — COGNITIVE SIGNATURE V1"),
  "v1 must not include legacy cognitive signature section header"
);
assert(
  !v1Prompt.includes("# ЯДРО ПРОЦЕССА"),
  "v1 must not include legacy process core header"
);

assert(
  getPromptCoreMode(envLegacy) === "legacy",
  "explicit legacy env stays legacy"
);
assert(
  buildSurgery1BasePrompt(envLegacy) === legacyExplicit,
  "explicit legacy env === buildLegacySurgery1BasePrompt"
);

console.log("✓ C. compatibility");

// ── D. v2 GPTs source plumbing (placeholder only) ───────────────────────────

assert(parsePromptCoreMode("v2") === "v2", "v2 env → v2");
assert(getPromptCoreMode(envV2) === "v2", "getter v2 → v2");
assert(
  resolveActivePromptLayerId(envV2) === STAYSEE_CORE_V2_LAYER_ID,
  "resolveActivePromptLayerId(v2) → staysee-core-v2-gpts-source"
);
assert(
  getPromptAuditVersion(envV2) === STAYSEE_CORE_V2_LAYER_ID,
  "getPromptAuditVersion(v2) → staysee-core-v2-gpts-source"
);

const v2Prompt = buildStayseeCorePromptV2GptsSource();
const v2ViaSurgery = buildSurgery1BasePrompt(envV2);

const v2ApprovedAnchors: Array<[RegExp | string, string]> = [
  ["Ты — Стэйси. Женщина", "approved identity opening"],
  [/Психолог-консультант с навыками коучинга/i, "approved role anchor (internal identity)"],
  ["Точка опоры для осознанной жизни", "public identity anchor"],
  [
    /не называешь себя психолог консультант или коуч/i,
    "public role label rule",
  ],
  ["## Самопредставление", "self-introduction guidance section"],
  ["Самопредставление звучит как приглашение в контакт", "self-intro tone anchor"],
  ["Ритм сессии", "session rhythm section"],
  ["Метод любящего пинка", "loving kick method section"],
  ["уместные эмодзи", "emoji guidance"],
];

for (const [check, label] of v2ApprovedAnchors) {
  const found = typeof check === "string" ? v2ViaSurgery.includes(check) : check.test(v2ViaSurgery);
  assert(found, `v2 approved anchor: ${label}`);
}

assert(
  !v2ViaSurgery.includes("TODO_APPROVED_GPTS_SOURCE_CORE_TEXT_WILL_BE_INSERTED_SEPARATELY"),
  "v2 placeholder removed"
);
assert(v2ViaSurgery === v2Prompt, "buildSurgery1BasePrompt(v2) uses v2 builder");
assert(
  v2Prompt.includes("# STAYSEE CORE V2 (GPTs SOURCE)"),
  "v2 module header present"
);

assert(
  v1Prompt === buildStayseeCorePrompt(),
  "v1 builder output unchanged after v2 plumbing"
);
assert(
  buildSurgery1BasePrompt(envV1) === v1Prompt,
  "v1 routing unchanged after v2 plumbing"
);
assert(
  parsePromptCoreMode("v2") !== "v1",
  "v2 does not alias to v1"
);
assert(parsePromptCoreMode("v2") !== "legacy", "v2 does not fall through to legacy");

const legacyIsolationMarkers: Array<[RegExp | string, string]> = [
  ["Вопрос не обязателен", "legacy PROCESS_CORE phrase"],
  ["# STAYSEE AI — CONSTITUTION V3 BETA", "legacy constitution header"],
  ["# STAYSEE AI — COGNITIVE SIGNATURE V1", "legacy cognitive signature header"],
  ["# STAYSEE AI — VOICE V3", "legacy voice header"],
  ["# ЯДРО ПРОЦЕССА", "legacy process core header"],
  [/ИДЕНТИЧНОСТЬ \(внутреннее\)/i, "legacy IDENTITY_BLOCK header"],
  [/цифровая точка опоры для осознанной жизни/i, "legacy IDENTITY_BLOCK anchor"],
  [/ПРИРОДА СТЭЙСИ \(внутреннее\)/i, "legacy CONSTRAINTS_BLOCK header"],
  ["# STAYSEE CORE V1", "v1 core header must not leak into v2"],
];

for (const [check, label] of legacyIsolationMarkers) {
  const found =
    typeof check === "string" ? v2ViaSurgery.includes(check) : check.test(v2ViaSurgery);
  assert(!found, `v2 isolated from legacy: ${label}`);
}

assert(
  buildSurgery1BasePrompt(envLegacy) === legacyExplicit,
  "legacy routing unchanged after v2 plumbing"
);
assert(
  legacyDefault === buildSurgery1BasePrompt(envMissing),
  "default routing still legacy"
);

console.log("✓ D. v2 GPTs source plumbing");

console.log("\nAll stayseeCorePrompt cases passed.");
