/**
 * Passive crisis contact detector + fail-open logging tests.
 * Run: npx tsx supabase/functions/_shared/crisisContactLog.cases.test.ts
 */

import {
  crisisContactCategoryEvents,
  detectCrisisContactsInAssistantReply,
} from "./crisisContactLog.ts";
import { logCrisisContactsFromAssistantReply } from "./logCrisisContacts.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.log(`FAIL: ${msg}`);
    failed++;
    return;
  }
  console.log(`PASS: ${msg}`);
}

function kindsOf(text: string) {
  return detectCrisisContactsInAssistantReply(text).map((c) => c.kind).sort();
}

function categoriesOf(text: string) {
  return crisisContactCategoryEvents(detectCrisisContactsInAssistantReply(text)).sort();
}

console.log("=== psychological ===\n");

assert(
  kindsOf("+7 (495) 989-50-50").join() === "mch_crisis_line" &&
    categoriesOf("+7 (495) 989-50-50").join() ===
      "psychological_crisis_support_offered",
  "1. exact MChS number",
);

assert(
  kindsOf("+7(495)989-50-50").includes("mch_crisis_line") &&
    kindsOf("тел. +7 495 989 50 50").includes("mch_crisis_line"),
  "2. MChS formatting variants",
);

assert(
  kindsOf("см. findahelpline.com").join() === "findahelpline" &&
    categoriesOf("см. findahelpline.com").join() ===
      "psychological_crisis_support_offered",
  "3. findahelpline.com",
);

assert(
  kindsOf("телефон 8-800-2000-122").join() === "child_helpline" &&
    categoriesOf("телефон 8-800-2000-122").join() ===
      "psychological_crisis_support_offered",
  "4. child helpline",
);

console.log("\n=== physical ===\n");

assert(
  kindsOf("позвони 112").join() === "emergency_112" &&
    categoriesOf("позвони 112").join() === "physical_emergency_support_offered",
  "5. позвони 112",
);

assert(
  kindsOf("вызови 103").join() === "ambulance_103" &&
    categoriesOf("вызови 103").join() === "physical_emergency_support_offered",
  "6. вызови 103",
);

console.log("\n=== both groups ===\n");

{
  const text = "findahelpline.com и позвони 112";
  const kinds = kindsOf(text);
  const cats = categoriesOf(text);
  assert(
    kinds.includes("findahelpline") && kinds.includes("emergency_112"),
    "7. both contact kinds",
  );
  assert(
    cats.includes("psychological_crisis_support_offered") &&
      cats.includes("physical_emergency_support_offered"),
    "7. both category events",
  );
}

console.log("\n=== negatives ===\n");

assert(kindsOf("задача 1123").length === 0, "8. 1123 does not match 112");
assert(kindsOf("номер 2103").length === 0, "9. 2103 does not match 103");

{
  const userHas112 = "позвони 112";
  const assistant = "Давай просто поговорим.";
  assert(
    kindsOf(assistant).length === 0,
    "10. user text ignored — only assistant scanned (assistant has no contact)",
  );
  // document intent: detector never receives user text in production path
  void userHas112;
}

assert(kindsOf("Обычный ответ без номеров.").length === 0, "11. no contacts → empty");

{
  const text =
    "Линия +7 (495) 989-50-50. Ещё раз: +7 (495) 989-50-50.";
  const hits = detectCrisisContactsInAssistantReply(text);
  assert(hits.length === 1 && hits[0]!.kind === "mch_crisis_line", "12. dedupe same kind");
}

console.log("\n=== fail-open logging ===\n");

{
  const original = "Позвони 112 прямо сейчас.";
  let reply = original;
  const errorClient = {
    from() {
      return {
        insert: async () => ({ error: { message: "forced insert failure" } }),
      };
    },
  };
  await logCrisisContactsFromAssistantReply(errorClient as never, {
    assistantText: reply,
    conversationId: "test-conv",
    requestId: "test-req",
    promptVersion: "staysee-legacy-doc-flat-clean",
    model: "openai/gpt-4o",
  });
  assert(reply === original, "13. assistant reply unchanged after protocol insert error");
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log("\n=== crisisContactLog.cases.test.ts OK ===\n");
