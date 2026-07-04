/**
 * Short acknowledgement routing (diagnostic only).
 * Legacy continuation tokens (Продолжать/продолжи/дальше) are not session routing.
 * Run: npx tsx supabase/functions/_shared/shortAckRouting.cases.test.ts
 */

import { analyzeResponseDepth } from "./responseDepthTrajectory.ts";

type Turn = { role: "user" | "assistant"; content: string };

function buildHistory(pairs: Array<[string, string?]>): Turn[] {
  const out: Turn[] = [];
  for (const [user, assistant] of pairs) {
    out.push({ role: "user", content: user });
    if (assistant) out.push({ role: "assistant", content: assistant });
  }
  return out;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const legacyCases: Array<{
  name: string;
  message: string;
  history: Turn[];
  notGreetingShort: boolean;
  openFigure?: boolean;
}> = [
  {
    name: "fear arc да",
    message: "да",
    history: buildHistory([
      ["мне страшно", "Где в теле это сейчас чувствуется?"],
    ]),
    notGreetingShort: true,
    openFigure: true,
  },
  {
    name: "gold arc да",
    message: "да",
    history: buildHistory([
      ["они мне просто не подходят", "..."],
      ["на ум приходит золотой", "В золоте есть что-то про тепло или про заметность?"],
      ["ну пока это только украшения", "..."],
    ]),
    notGreetingShort: true,
    openFigure: true,
  },
  {
    name: "uncertainty угу",
    message: "угу",
    history: buildHistory([
      ["я не знаю", "Можно просто заметить, где это ощущается."],
    ]),
    notGreetingShort: true,
    openFigure: true,
  },
  {
    name: "isolated да",
    message: "да",
    history: [],
    notGreetingShort: false,
  },
  {
    name: "isolated привет",
    message: "привет",
    history: [],
    notGreetingShort: false,
  },
];

console.log("=== short ack routing ===\n");

for (const c of legacyCases) {
  const analysis = analyzeResponseDepth(c.message, "normal", c.history);
  if (c.notGreetingShort) {
    assert(
      analysis.depthReason !== "greeting_short",
      `${c.name}: expected not greeting_short, got ${analysis.depthReason}`
    );
  } else if (c.message === "привет" || c.message === "да") {
    assert(
      analysis.depthReason === "greeting_short",
      `${c.name}: expected greeting_short, got ${analysis.depthReason}`
    );
  }

  if (c.openFigure !== undefined) {
    assert(
      analysis.openFigure.isOpen === c.openFigure,
      `${c.name}: openFigure=${analysis.openFigure.isOpen} expected ${c.openFigure}`
    );
  }

  console.log(
    `PASS: ${c.name} → reason=${analysis.depthReason} open=${analysis.openFigure.isOpen}`
  );
}

console.log("\n=== legacy continuation tokens — no arc_continuation routing ===\n");

const emotionalHistory = buildHistory([
  [
    "Мне кажется, на мне всё сидит ужасно.",
    "Понимаю, как это может быть неприятно. Можем вместе исследовать, что стоит за этими мыслями.",
  ],
]);

for (const variant of [
  "Продолжать",
  "продолжи",
  "продолжай",
  "дальше",
  "давай дальше",
  "и?",
  "ну и?",
  "ещё",
  "continue",
  "go on",
]) {
  const analysis = analyzeResponseDepth(variant, "normal", emotionalHistory);
  assert(
    analysis.openFigure.trigger !== "arc_continuation",
    `${variant}: must not route arc_continuation, got ${analysis.openFigure.trigger}`
  );
  console.log(
    `PASS: ${variant} → trigger=${analysis.openFigure.trigger} reason=${analysis.depthReason}`
  );
  assert(
    !analysis.openFigure.isOpen,
    `${variant}: must not open figure in emotional arc`
  );
}

{
  const analysis = analyzeResponseDepth("Продолжать", "normal", []);
  assert(
    !analysis.openFigure.isOpen,
    "isolated Продолжать: openFigure must stay closed"
  );
  assert(
    analysis.openFigure.trigger !== "arc_continuation",
    "isolated Продолжать: must not invent arc_continuation"
  );
  console.log("PASS: isolated Продолжать → no arc without prior context");
}

{
  const greetingOnlyHistory = buildHistory([["привет", "Привет!"]]);
  const analysis = analyzeResponseDepth(
    "Продолжать",
    "normal",
    greetingOnlyHistory
  );
  assert(
    analysis.openFigure.trigger !== "arc_continuation",
    "greeting-only prior assistant: must not open arc_continuation"
  );
  console.log("PASS: greeting-only prior assistant + Продолжать → no arc");
}

console.log("\nAll short ack routing cases passed.");
