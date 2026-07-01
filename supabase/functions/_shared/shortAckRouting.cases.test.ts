/**
 * Short acknowledgement + continuation token routing.
 * Run: npx tsx supabase/functions/_shared/shortAckRouting.cases.test.ts
 */

import {
  analyzeResponseDepth,
  isContinuationToken,
} from "./responseDepthTrajectory.ts";
import { buildOpenFigureTurnGuidance } from "./openFigureTurnGuidance.ts";

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

function expectContinuationRouting(
  name: string,
  message: string,
  history: Turn[]
): void {
  const analysis = analyzeResponseDepth(message, "normal", history);
  assert(
    analysis.depthReason !== "greeting_short",
    `${name}: expected not greeting_short, got ${analysis.depthReason}`
  );
  assert(
    analysis.depthReason !== "short_neutral",
    `${name}: expected not short_neutral, got ${analysis.depthReason}`
  );
  assert(analysis.openFigure.isOpen, `${name}: expected openFigure.isOpen`);
  assert(
    analysis.openFigure.trigger === "arc_continuation",
    `${name}: expected arc_continuation trigger, got ${analysis.openFigure.trigger}`
  );
  const guidance = buildOpenFigureTurnGuidance({
    openFigure: analysis.openFigure,
    depthReason: analysis.depthReason,
    safetyCategory: "normal",
  });
  assert(Boolean(guidance), `${name}: expected guidance`);
  assert(
    /продолжение\s+дуги/i.test(guidance!),
    `${name}: expected arc continuation guidance`
  );
  assert(
    /не спрашивай.*о чём поговорим/i.test(guidance!),
    `${name}: guidance must forbid generic topic reset`
  );
  console.log(
    `PASS: ${name} → reason=${analysis.depthReason} open=${analysis.openFigure.isOpen}`
  );
}

const legacyCases: Array<{
  name: string;
  message: string;
  history: Turn[];
  notGreetingShort: boolean;
  openFigure?: boolean;
  guidance?: boolean;
}> = [
  {
    name: "fear arc да",
    message: "да",
    history: buildHistory([
      ["мне страшно", "Где в теле это сейчас чувствуется?"],
    ]),
    notGreetingShort: true,
    openFigure: true,
    guidance: true,
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
    guidance: true,
  },
  {
    name: "uncertainty угу",
    message: "угу",
    history: buildHistory([
      ["я не знаю", "Можно просто заметить, где это ощущается."],
    ]),
    notGreetingShort: true,
    openFigure: true,
    guidance: true,
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

  if (c.guidance !== undefined) {
    const guidance = buildOpenFigureTurnGuidance({
      openFigure: analysis.openFigure,
      depthReason: analysis.depthReason,
      safetyCategory: "normal",
    });
    assert(
      Boolean(guidance) === c.guidance,
      `${c.name}: guidance=${Boolean(guidance)} expected ${c.guidance}`
    );
  }

  console.log(
    `PASS: ${c.name} → reason=${analysis.depthReason} open=${analysis.openFigure.isOpen}`
  );
}

console.log("\n=== continuation token routing ===\n");

const bodyShameHistory = buildHistory([
  [
    "Мне кажется, на мне всё сидит ужасно.",
    "Понимаю, как это может быть неприятно. Можем вместе исследовать, что стоит за этими мыслями.",
  ],
]);
expectContinuationRouting(
  "body shame + Продолжать",
  "Продолжать",
  bodyShameHistory
);

const confusionHistory = buildHistory([
  [
    "Я теряюсь и не понимаю, что мне подойдёт.",
    "Давай разберёмся вместе — что для тебя важно в выборе и где сейчас растерянность.",
  ],
]);
expectContinuationRouting(
  "confusion + Продолжать",
  "Продолжать",
  confusionHistory
);

for (const variant of [
  "продолжи",
  "продолжай",
  "дальше",
  "давай дальше",
  "и?",
  "ну и?",
  "ещё",
]) {
  assert(
    isContinuationToken(variant),
    `isContinuationToken should match: ${variant}`
  );
  expectContinuationRouting(
    `confusion + ${variant}`,
    variant,
    confusionHistory
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
    !analysis.openFigure.isOpen ||
      analysis.openFigure.trigger !== "arc_continuation",
    "greeting-only prior assistant: must not open arc_continuation"
  );
  console.log("PASS: greeting-only prior assistant + Продолжать → no arc");
}

console.log("\nAll short ack routing cases passed.");
