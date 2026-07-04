/**
 * Explicit closure detection + guidance — unit cases.
 * Run: npx tsx supabase/functions/_shared/explicitClosureTurnGuidance.cases.test.ts
 */

import { analyzeResponseDepth, isExplicitConversationClosure } from "./responseDepthTrajectory.ts";
import {
  buildExplicitClosureTurnGuidance,
  explicitClosureGuidanceInjected,
} from "./explicitClosureTurnGuidance.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const EXIT_PHRASES = [
  "Пора бежать.",
  "Побежала.",
  "Убегаю.",
  "Надо идти.",
  "До связи.",
  "Увидимся.",
  "На сегодня всё.",
  "Мне достаточно.",
  "Пойду работать.",
  "Я пойду спать.",
  "Ладно, пойду чай пить.",
  "Я побежала",
  "пойду спать",
  "всё, я ушла",
];

for (const phrase of EXIT_PHRASES) {
  assert(
    isExplicitConversationClosure(phrase),
    `closure should match: ${phrase}`
  );
  const analysis = analyzeResponseDepth(phrase, "normal", []);
  assert(
    analysis.depthReason === "explicit_closure",
    `${phrase}: expected explicit_closure, got ${analysis.depthReason}`
  );
  const guidance = buildExplicitClosureTurnGuidance({
    depthReason: analysis.depthReason,
    message: phrase,
  });
  assert(!!guidance, `${phrase}: expected closure guidance`);
  assert(
    explicitClosureGuidanceInjected({
      depthReason: analysis.depthReason,
      message: phrase,
    }),
    `${phrase}: guidanceInjected`
  );
}
console.log(`✓ ${EXIT_PHRASES.length} exit phrases`);

assert(
  isExplicitConversationClosure("Не знаю, на сегодня всё"),
  "compound closure"
);
assert(
  isExplicitConversationClosure("Пока непонятно, пойду спать"),
  "compound closure with sleep"
);
const compound = analyzeResponseDepth("Не знаю, на сегодня всё", "normal", []);
assert(compound.depthReason === "explicit_closure", "compound → explicit_closure");
console.log("✓ closure > uncertainty on compound messages");

assert(!isExplicitConversationClosure("Даже не знаю"), "uncertainty is not closure");
console.log("✓ uncertainty phrases not closure");

{
  const block = buildExplicitClosureTurnGuidance({
    depthReason: "explicit_closure",
    message: "На сегодня всё, пока.",
  });
  assert(!!block, "closure guidance block");
  assert(/буду\s+ждать/i.test(block!), "forbids буду ждать");
  assert(/я\s+всегда\s+здесь/i.test(block!), "forbids я всегда здесь");
  assert(/возвращайся/i.test(block!), "forbids возвращайся");
  console.log("✓ explicit closure guidance forbids invite-back / availability");
}

console.log("\nAll explicitClosureTurnGuidance cases passed.");
