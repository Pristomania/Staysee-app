/**
 * Short acknowledgement routing — must not reset greeting inside active conversation.
 * Run: npx tsx supabase/functions/_shared/shortAckRouting.cases.test.ts
 */

import { analyzeResponseDepth } from "./responseDepthTrajectory.ts";
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

const cases: Array<{
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

for (const c of cases) {
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

console.log("\nAll short ack routing cases passed.");
