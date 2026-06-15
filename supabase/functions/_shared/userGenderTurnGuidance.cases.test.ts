/**
 * User gender turn guidance — unit cases.
 * Run: npx tsx supabase/functions/_shared/userGenderTurnGuidance.cases.test.ts
 */

import {
  buildUserGenderTurnGuidance,
  canAskGenderPreference,
  isAcuteDistressMessage,
} from "./userGenderTurnGuidance.ts";
import type { GenderDetectionResult } from "./userGrammaticalGender.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function guidance(
  result: GenderDetectionResult,
  opts: {
    safetyCategory?: "normal" | "crisis" | "emotional_support";
    message?: string;
    userTurnCount?: number;
  } = {}
) {
  return buildUserGenderTurnGuidance(result, {
    safetyCategory: opts.safetyCategory ?? "normal",
    message: opts.message ?? "Спокойный разговор",
    userTurnCount: opts.userTurnCount ?? 4,
  });
}

console.log("=== userGenderTurnGuidance.cases ===\n");

const fem = guidance({
  gender: "feminine",
  confidence: "high",
  source: "detector",
});
assert(Boolean(fem?.includes("женском роде")), "feminine high hint");
assert(Boolean(fem?.includes("ты устала")), "feminine examples");
console.log("PASS guidance: feminine high");

const masc = guidance({
  gender: "masculine",
  confidence: "high",
  source: "detector",
});
assert(Boolean(masc?.includes("мужском роде")), "masculine high hint");
assert(Boolean(masc?.includes("ты устал")), "masculine examples");
console.log("PASS guidance: masculine high");

const neutral = guidance({
  gender: "neutral",
  confidence: "high",
  source: "memory",
});
assert(Boolean(neutral?.includes("нейтральн")), "neutral hint");
console.log("PASS guidance: neutral preference");

const unknownEarly = guidance(
  { gender: "unknown", confidence: "low", source: "unknown" },
  { userTurnCount: 1, message: "Привет" }
);
assert(unknownEarly === null, "unknown early → no hint");
console.log("PASS guidance: unknown calm early");

const unknownAcute = guidance(
  { gender: "unknown", confidence: "low", source: "unknown" },
  { message: "Мне плохо", userTurnCount: 5 }
);
assert(unknownAcute === null, "unknown acute → no question");
assert(isAcuteDistressMessage("Мне плохо"), "acute detector");
console.log("PASS guidance: unknown acute/crisis → no question");

const unknownCrisis = guidance(
  { gender: "unknown", confidence: "low", source: "unknown" },
  { safetyCategory: "crisis", message: "Спокойно", userTurnCount: 5 }
);
assert(unknownCrisis === null, "crisis → no gender ask");
console.log("PASS guidance: crisis → no question");

const unknownCalmLate = guidance(
  { gender: "unknown", confidence: "low", source: "unknown" },
  { message: "Интересная тема", userTurnCount: 4 }
);
assert(
  Boolean(unknownCalmLate?.includes("женском, мужском или нейтрально")),
  "unknown calm late → soft ask"
);
assert(canAskGenderPreference({
  safetyCategory: "normal",
  message: "Интересная тема",
  userTurnCount: 4,
}), "can ask when calm");
console.log("PASS guidance: unknown calm 3+ turns");

const lowConf = guidance({
  gender: "feminine",
  confidence: "low",
  source: "detector",
});
assert(lowConf === null, "low confidence → no hard hint");
console.log("PASS guidance: low confidence no hard hint");

console.log("\nAll userGenderTurnGuidance cases passed.");
