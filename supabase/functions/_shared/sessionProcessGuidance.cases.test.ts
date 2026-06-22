/**
 * Session process guidance — unit cases.
 * Run: npx tsx supabase/functions/_shared/sessionProcessGuidance.cases.test.ts
 */

import type { SessionProcessState } from "./sessionProcessState.ts";
import {
  buildSessionProcessGuidance,
  buildSessionProcessGuidanceBlock,
  getSessionProcessGuidanceMode,
  parseSessionProcessGuidanceMode,
  sessionProcessGuidanceInjected,
} from "./sessionProcessGuidance.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const envOn = () => "on" as string | undefined;
const envOff = () => "off" as string | undefined;
const envMissing = () => undefined;

const representativeState: SessionProcessState = {
  contact: "active",
  movement: "opening",
  closure: "none",
  certainty: "low",
  source: "legacy_shadow",
  updatedAt: "2026-06-17T12:00:00.000Z",
};

// ── Env flag ─────────────────────────────────────────────────────────────────

assert(parseSessionProcessGuidanceMode(undefined) === "off", "missing env → off");
assert(getSessionProcessGuidanceMode(envMissing) === "off", "getter missing → off");
assert(parseSessionProcessGuidanceMode("") === "off", "empty string → off");
assert(parseSessionProcessGuidanceMode("invalid") === "off", "invalid → off");
assert(parseSessionProcessGuidanceMode("on") === "on", "on → on");
assert(getSessionProcessGuidanceMode(envOn) === "on", "getter on → on");
assert(parseSessionProcessGuidanceMode("off") === "off", "off → off");
assert(getSessionProcessGuidanceMode(envOff) === "off", "getter off → off");
console.log("✓ env flag off / on");

// ── Null state ───────────────────────────────────────────────────────────────

assert(
  buildSessionProcessGuidance({
    priorState: null,
    explicitClosureActive: false,
    safetyCategory: "normal",
    readEnv: envOn,
  }) === null,
  "null priorState → no guidance"
);
assert(
  !sessionProcessGuidanceInjected({
    priorState: null,
    explicitClosureActive: false,
    safetyCategory: "normal",
    readEnv: envOn,
  }),
  "null priorState → not injected"
);
console.log("✓ null priorState");

// ── Suppression ──────────────────────────────────────────────────────────────

assert(
  buildSessionProcessGuidance({
    priorState: representativeState,
    explicitClosureActive: false,
    safetyCategory: "normal",
    readEnv: envOff,
  }) === null,
  "flag off → no guidance"
);

assert(
  buildSessionProcessGuidance({
    priorState: representativeState,
    explicitClosureActive: true,
    safetyCategory: "normal",
    readEnv: envOn,
  }) === null,
  "explicit closure → no guidance"
);

assert(
  buildSessionProcessGuidance({
    priorState: representativeState,
    explicitClosureActive: false,
    safetyCategory: "crisis",
    readEnv: envOn,
  }) === null,
  "crisis → no guidance"
);

assert(
  buildSessionProcessGuidance({
    priorState: representativeState,
    explicitClosureActive: false,
    safetyCategory: "prompt_attack",
    readEnv: envOn,
  }) === null,
  "prompt_attack → no guidance"
);
console.log("✓ suppression: flag off, explicit closure, immediate safety");

// ── Generation ───────────────────────────────────────────────────────────────

const guidance = buildSessionProcessGuidance({
  priorState: representativeState,
  explicitClosureActive: false,
  safetyCategory: "normal",
  readEnv: envOn,
});
assert(!!guidance, "representative state → guidance");
assert(
  guidance!.includes("СОСТОЯНИЕ ПРОЦЕССА (предыдущий ход)"),
  "guidance contains header"
);
assert(guidance!.includes("Контакт в разговоре:"), "guidance contains contact line");
assert(guidance!.includes("Движение темы:"), "guidance contains movement line");
assert(guidance!.includes("Закрытие:"), "guidance contains closure line");
assert(guidance!.includes("Определённость:"), "guidance contains certainty line");
assert(
  sessionProcessGuidanceInjected({
    priorState: representativeState,
    explicitClosureActive: false,
    safetyCategory: "normal",
    readEnv: envOn,
  }),
  "representative state → injected"
);
console.log("✓ representative state generation");

const block = buildSessionProcessGuidanceBlock(representativeState);
const blockLines = block.split("\n").filter((line) => line.trim().length > 0);
assert(blockLines.length === 5, "block has header + 4 state lines");

// ── Style guard ──────────────────────────────────────────────────────────────

const forbiddenPatterns = [
  /не делай/i,
  /не говори/i,
  /запрещено/i,
  /\bforbid\b/i,
  /\bmust not\b/i,
  /contact=/i,
  /movement=/i,
  /closure=/i,
  /certainty=/i,
];

for (const [axis, state] of [
  ["contact", { ...representativeState, contact: "reduced" as const }],
  ["movement", { ...representativeState, movement: "stuck" as const }],
  ["closure", { ...representativeState, closure: "user_closing" as const }],
  ["certainty", { ...representativeState, certainty: "high" as const }],
] as const) {
  const axisBlock = buildSessionProcessGuidanceBlock(state);
  for (const pattern of forbiddenPatterns) {
    assert(
      !pattern.test(axisBlock),
      `${axis}: style guard failed for ${pattern}`
    );
  }
}
console.log("✓ style guard");

console.log("\nAll sessionProcessGuidance cases passed.");
