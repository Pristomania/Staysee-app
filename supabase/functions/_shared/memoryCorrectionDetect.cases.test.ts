/**
 * Run: npx tsx supabase/functions/_shared/memoryCorrectionDetect.cases.test.ts
 */

import {
  detectMemoryCorrection,
  isEphemeralDenialOnly,
} from "./memoryCorrectionDetect.ts";
import { MEMORY_CORRECTION_SUBJECTS } from "./memoryCorrectionSubjects.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

console.log("=== memory correction detect ===\n");

const cohab = detectMemoryCorrection({
  message: "Нет, мы не живём вместе, мы живём отдельно",
  hasConversationId: true,
});
assert(cohab != null, "cohabitation correction detected");
assert(
  cohab!.subjectKey === MEMORY_CORRECTION_SUBJECTS.cohabitation,
  "subject is cohabitation"
);
assert(cohab!.scope === "conversation", "default scope is conversation");
console.log("PASS: cohabitation correction");

const tired = detectMemoryCorrection({
  message: "Нет, я просто устала",
  hasConversationId: true,
});
assert(tired == null, "tired denial is not durable");
assert(isEphemeralDenialOnly("Нет, я просто устала"), "ephemeral denial");
console.log("PASS: broad net does not create durable correction");

const globalCohab = detectMemoryCorrection({
  message: "Везде: мы с партнёром не живём вместе, живём отдельно",
  hasConversationId: true,
});
assert(globalCohab?.scope === "global", "explicit global scope");
console.log("PASS: global scope marker");

const status = detectMemoryCorrection({
  message: "Мы с партнёром не вместе, мы расстались",
  hasConversationId: true,
});
assert(status?.subjectKey === MEMORY_CORRECTION_SUBJECTS.status, "status subject");
console.log("PASS: relationship status");

const del = detectMemoryCorrection({
  message: "Удали из памяти: партнёр живёт вместе со мной",
  hasConversationId: true,
});
assert(del?.subjectKey === MEMORY_CORRECTION_SUBJECTS.deleteFact, "delete fact");
assert((del?.oldText?.length ?? 0) >= 8, "delete target extracted");
console.log("PASS: explicit delete command");

const fab = detectMemoryCorrection({
  message: "Ты придумала, мы не живём вместе",
  hasConversationId: true,
});
assert(fab == null, "fabrication accusation alone is not durable v1");
console.log("PASS: fabrication not durable");

console.log("\nAll memoryCorrectionDetect cases passed.");
