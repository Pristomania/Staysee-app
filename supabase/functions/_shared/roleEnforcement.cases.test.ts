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

const FRUSTRATION_USER_MESSAGE = "ты меня бесишь, одно и то же повторяешь";

const LONG_FRUSTRATION_REPLY =
  `Слышу твоё раздражение — и оно имеет смысл. Ты злишься не просто так, и мне важно быть с этим честно, а не отмахиваться.\n\n` +
  `Похоже, тебе не хватает живого контакта, а не ещё одной формулировки. "Да, я понимаю." "Я рядом." — это может звучать как шаблон, когда внутри копится злость.\n\n` +
  `Ты можешь злиться на повтор, на тон, на ощущение, что тебя не слышат — и это не значит, что ты "неправильная". Это значит, что контакт сейчас не попадает туда, куда тебе нужно.\n\n` +
  `Если хочешь, можем остановиться на том, что сейчас больше всего бесит: сам тон, повтор, ощущение, что тебя не слышат — или что-то другое?\n\n` +
  `Что из этого ближе к тому, что ты чувствуешь прямо сейчас?`;

// userFrustrationAtBot must not truncate long publishable reply
{
  assert(LONG_FRUSTRATION_REPLY.length > 520, "fixture must exceed old 520 char cap");
  assert(isPublishableReply(LONG_FRUSTRATION_REPLY), "fixture must be publishable");

  const out = enforceRoleBoundedReply(LONG_FRUSTRATION_REPLY, "normal", {
    relationalLifeTurn: false,
    userMessage: FRUSTRATION_USER_MESSAGE,
  });

  assert(out === LONG_FRUSTRATION_REPLY.trim(), "userFrustrationAtBot must not truncate publishable reply");
  assert(out.length === LONG_FRUSTRATION_REPLY.trim().length, "length must be unchanged");
  assert(out.endsWith("прямо сейчас?"), "contact tail must be preserved");
  console.log("PASS: userFrustrationAtBot does not truncate long publishable reply");
}

// bounded / mustPivot states must not truncate publishable output
{
  assert(LONG_RELATIONAL_REPLY.length > 520, "fixture must exceed old caps");
  assert(isPublishableReply(LONG_RELATIONAL_REPLY), "fixture must be publishable");

  const cases = [
    { category: "off_topic" as const, label: "off_topic" },
    { category: "boundary_pressure" as const, label: "boundary_pressure" },
    { category: "medical_boundary" as const, label: "medical_boundary" },
  ];

  for (const { category, label } of cases) {
    const out = enforceRoleBoundedReply(LONG_RELATIONAL_REPLY, category, {
      insistenceLoop: true,
      threadEscalated: true,
      userMessage: "Напиши мне контент-план на неделю",
      relationalLifeTurn: false,
    });
    assert(out === LONG_RELATIONAL_REPLY.trim(), `${label} must not truncate publishable reply`);
  }
  console.log("PASS: bounded/mustPivot states do not truncate publishable output");
}

console.log("\nAll roleEnforcement cases passed.");
