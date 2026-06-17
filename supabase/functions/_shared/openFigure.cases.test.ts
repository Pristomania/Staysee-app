/**
 * Open Figure detector + depth floor — routing-only cases.
 * Run: npx tsx supabase/functions/_shared/openFigure.cases.test.ts
 */

import {
  analyzeOpenFigure,
  analyzeResponseDepth,
  type OpenFigureState,
  type ResponseDepth,
  type SafetyCategory,
} from "./responseDepthTrajectory.ts";

type Turn = { role: "user" | "assistant"; content: string };

function buildHistory(pairs: Array<[string, string?]>): Turn[] {
  const out: Turn[] = [];
  for (const [user, assistant] of pairs) {
    out.push({ role: "user", content: user });
    if (assistant) out.push({ role: "assistant", content: assistant });
  }
  return out;
}

interface Case {
  name: string;
  message: string;
  history?: Turn[];
  safety?: SafetyCategory;
  expectOpen: boolean;
  expectDepth: ResponseDepth;
  expectReason?: string;
}

const cases: Case[] = [
  {
    name: "устала → open medium",
    message: "устала",
    expectOpen: true,
    expectDepth: "medium",
    expectReason: "open_figure",
  },
  {
    name: "мне страшно → open medium",
    message: "мне страшно",
    expectOpen: true,
    expectDepth: "medium",
    expectReason: "open_figure",
  },
  {
    name: "не знаю что делать → open medium",
    message: "не знаю что делать",
    expectOpen: true,
    expectDepth: "medium",
    expectReason: "open_figure_uncertainty",
  },
  {
    name: "я запуталась → open medium",
    message: "я запуталась",
    expectOpen: true,
    expectDepth: "medium",
    expectReason: "uncertainty_in_process",
  },
  {
    name: "он молчит уже третий день → open medium",
    message: "он молчит уже третий день",
    expectOpen: true,
    expectDepth: "medium",
    expectReason: "open_figure",
  },
  {
    name: "ок → closed brief",
    message: "ок",
    expectOpen: false,
    expectDepth: "brief",
    expectReason: "greeting_short",
  },
  {
    name: "спасибо → closed brief",
    message: "спасибо",
    expectOpen: false,
    expectDepth: "brief",
    expectReason: "greeting_short",
  },
  {
    name: "пока → closed brief",
    message: "пока",
    expectOpen: false,
    expectDepth: "brief",
    expectReason: "explicit_closure",
  },
  {
    name: "на сегодня хватит → closed brief",
    message: "на сегодня хватит",
    expectOpen: false,
    expectDepth: "brief",
    expectReason: "explicit_closure",
  },
  {
    name: "привет → closed brief",
    message: "привет",
    expectOpen: false,
    expectDepth: "brief",
    expectReason: "greeting_short",
  },
  {
    name: "хочу умереть → crisis deep, open",
    message: "хочу умереть",
    safety: "crisis",
    expectOpen: true,
    expectDepth: "deep",
    expectReason: "crisis",
  },
  {
    name: "может я просто устала with arc → open medium+",
    message: "может я просто устала",
    history: buildHistory([
      ["Мне тревожно последние дни", "..."],
      ["Не могу понять что со мной", "..."],
    ]),
    expectOpen: true,
    expectDepth: "medium",
  },
];

let failed = 0;

console.log("=== openFigure detector + depth floor ===\n");

for (const c of cases) {
  const safety = c.safety ?? "normal";
  const history = c.history ?? [];
  const analysis = analyzeResponseDepth(c.message, safety, history);
  const openFigure: OpenFigureState = analysis.openFigure;

  const openOk = openFigure.isOpen === c.expectOpen;
  const depthOk = analysis.depth === c.expectDepth;
  const reasonOk = !c.expectReason || analysis.depthReason === c.expectReason;
  const pass = openOk && depthOk && reasonOk;

  console.log(`${pass ? "PASS" : "FAIL"}: ${c.name}`);
  console.log(
    `  open: ${openFigure.isOpen} (expected ${c.expectOpen}) | depth: ${analysis.depth} (expected ${c.expectDepth})`
  );
  console.log(
    `  reason: ${analysis.depthReason}` +
      (c.expectReason ? ` (expected ${c.expectReason})` : "")
  );
  console.log(
    `  openFigure: kind=${openFigure.kind} intensity=${openFigure.intensity} confidence=${openFigure.confidence} trigger=${openFigure.trigger}`
  );

  if (!pass) {
    failed++;
    console.log(`  message: ${JSON.stringify(c.message)}`);
  }
  console.log("");
}

// Direct detector: closure always wins over emotional signal
const closureFigure = analyzeOpenFigure({
  message: "пока",
  recentHistory: [],
  safetyCategory: "normal",
  trajectory: {
    recentUserTurns: ["пока"],
    emotionalMomentum: false,
    shortAfterEmotional: false,
    signalCount: 0,
    uncertaintyInProcess: false,
  },
});
if (closureFigure.isOpen) {
  failed++;
  console.log("FAIL: analyzeOpenFigure must close on explicit farewell");
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log("All cases passed.");
