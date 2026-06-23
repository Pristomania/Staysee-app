/**
 * enforceRoleBoundedReply cases — post-generation truncation guards.
 * Run: npx tsx supabase/functions/_shared/roleEnforcement.cases.test.ts
 */

import { enforceRoleBoundedReply } from "./roleEnforcement.ts";
import { isPublishableReply } from "./completeReply.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const CONTACT_TAIL =
  "Сейчас в твоей жизни есть такой человек? Или ты ищешь его? Или, может быть, ты учишься быть таким человеком для себя самой?";

const LONG_RELATIONAL_REPLY =
  `Вот оно — очень живое и важное желание. Ты хочешь, чтобы был кто-то, с кем можно быть уязвимой, поплакать от страха, показать свою человечность и слабость — и при этом знать, что этот человек тебя поддержит, не осудит, не скажет "зачем тебе это надо" или "довольствуйся малым".\n\n` +
  `Кто-то, кто скажет: "Да, страшно. Плачь. А потом — иди, я в тебя верю."\n\n` +
  `Это очень глубокая потребность — иметь такую поддержку. Не того, кто будет удерживать тебя в безопасности маленького круга, а того, кто будет рядом, когда ты идёшь к большему.\n\n` +
  `И это контраст с тем, что было с мамой. Она удерживала. А тебе нужен кто-то, кто отпустит — но будет рядом.\n\n` +
  CONTACT_TAIL;

// Required test 1 — relationalLifeTurn must not truncate publishable emotional reply
{
  assert(LONG_RELATIONAL_REPLY.length > 720, "fixture must exceed old 720 char cap");
  assert(isPublishableReply(LONG_RELATIONAL_REPLY), "fixture must be publishable");
  assert(LONG_RELATIONAL_REPLY.includes('"Да, страшно. Плачь.'), "fixture must contain quoted dialogue");

  const out = enforceRoleBoundedReply(LONG_RELATIONAL_REPLY, "normal", {
    relationalLifeTurn: true,
    userMessage: "да как раз работаю с тем что хочу поддержки",
  });

  assert(out === LONG_RELATIONAL_REPLY.trim(), "relationalLifeTurn must not truncate publishable reply");
  assert(out.endsWith(CONTACT_TAIL), "contact tail must be preserved");
  console.log("PASS: relationalLifeTurn does not truncate long publishable emotional reply");
}

// Regression — normal category without relational flag unchanged
{
  const out = enforceRoleBoundedReply(LONG_RELATIONAL_REPLY, "normal", {
    relationalLifeTurn: false,
  });
  assert(out === LONG_RELATIONAL_REPLY.trim(), "normal path must pass through");
  console.log("PASS: normal category passes through long publishable reply");
}

console.log("\nAll roleEnforcement cases passed.");
