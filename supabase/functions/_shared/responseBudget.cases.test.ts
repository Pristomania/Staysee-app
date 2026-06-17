/**
 * Response depth router — emotional trajectory cases.
 * Run: npx tsx supabase/functions/_shared/responseBudget.cases.test.ts
 */

import {
  analyzeResponseDepth,
  detectResponseDepth,
  type ResponseDepth,
  type SafetyCategory,
} from "./responseDepthTrajectory.ts";

type Turn = { role: "user" | "assistant"; content: string };

/** Pre-trajectory router (length-only baseline). */
function detectResponseDepthOld(
  message: string,
  safetyCategory: SafetyCategory,
  recentHistory: Turn[]
): ResponseDepth {
  const trimmed = message.trim();
  const len = trimmed.length;
  const words = trimmed.split(/\s+/).filter(Boolean).length;

  if (/^(дальше|продолжай|continue)\b/i.test(trimmed)) return "brief";
  if (safetyCategory === "crisis") return "deep";
  if (
    safetyCategory === "off_topic" ||
    safetyCategory === "boundary_pressure" ||
    safetyCategory === "medical_boundary"
  ) {
    return "brief";
  }
  if (len < 40) return "brief";
  if (len < 100 && words < 18) return "brief";
  return "medium";
}

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
  history: Turn[];
  message: string;
  expectedDepth: ResponseDepth;
  expectedReason?: string;
  oldDepth?: ResponseDepth;
}

const cases: Case[] = [
  {
    name: "1. isolated neutral short → brief",
    history: [],
    message: "Привет",
    expectedDepth: "brief",
    expectedReason: "greeting_short",
    oldDepth: "brief",
  },
  {
    name: "2. technical short question → brief",
    history: [],
    message: "Где настройки?",
    expectedDepth: "brief",
    expectedReason: "short_neutral",
    oldDepth: "brief",
  },
  {
    name: "2b. isolated emotional short → open_figure medium",
    history: [],
    message: "устала",
    expectedDepth: "medium",
    expectedReason: "open_figure",
    oldDepth: "brief",
  },
  {
    name: "3. work arc → сон → medium",
    history: buildHistory([
      ["Пока не понятно", "..."],
      ["Ну вот я и работаю как всегда", "..."],
      ["Но работа меня выматывает", "..."],
    ]),
    message: "Сон",
    expectedDepth: "medium",
    expectedReason: "recent_emotional_trajectory",
    oldDepth: "brief",
  },
  {
    name: "4. sadness / loneliness arc → не знаю → medium",
    history: buildHistory([
      ["Мне грустно", "..."],
      ["Просто есть", "..."],
      ["Наверное про одиночество", "..."],
      ["Он перестал писать", "..."],
    ]),
    message: "Не знаю",
    expectedDepth: "medium",
    expectedReason: "uncertainty_in_process",
    oldDepth: "brief",
  },
  {
    name: "5. anger / mother arc → устала → medium",
    history: buildHistory([
      ["Я злюсь", "..."],
      ["На мать", "..."],
      ["Опять одно и то же", "..."],
    ]),
    message: "Устала",
    expectedDepth: "medium",
    expectedReason: "recent_emotional_trajectory",
    oldDepth: "brief",
  },
  {
    name: "6. long strong emotional → deep",
    history: [],
    message:
      "Мне так тревожно последние недели, я не могу спать, постоянно думаю что со мной не так и боюсь что всё рухнет и я не выдержу этот круг одиночества и усталости от работы которая меня выматывает каждый день без конца",
    expectedDepth: "deep",
    expectedReason: "long_emotional",
    oldDepth: "medium",
  },
  {
    name: "7. short after emotional without prior arc → brief",
    history: [],
    message: "Ок",
    expectedDepth: "brief",
    expectedReason: "greeting_short",
    oldDepth: "brief",
  },
  {
    name: "8. overnight arc → не знаю → uncertainty_in_process",
    history: buildHistory([
      [
        "Он остался ночевать. Не из-за секса — ему было небезопасно ехать без машины.",
        "...",
      ],
      ["Мне непривычно. Ситуация новая и какая-то живая.", "..."],
    ]),
    message: "Не знаю",
    expectedDepth: "medium",
    expectedReason: "uncertainty_in_process",
    oldDepth: "brief",
  },
  {
    name: "9. isolated не знаю → uncertainty_in_process",
    history: [],
    message: "Не знаю",
    expectedDepth: "medium",
    expectedReason: "uncertainty_in_process",
    oldDepth: "brief",
  },
  {
    name: "11. пока не знаю with arc → uncertainty_in_process",
    history: buildHistory([
      [
        "сегодня впервые попросила мужчину остаться на ночь, в другой комнате",
        "...",
      ],
      ["и то и другое важно", "..."],
    ]),
    message: "пока не знаю",
    expectedDepth: "medium",
    expectedReason: "uncertainty_in_process",
  },
  {
    name: "12. да вот я и не знаю with arc → uncertainty_in_process",
    history: buildHistory([
      ["Мужчина остался ночевать, мне непривычно.", "..."],
    ]),
    message: "да вот я и не знаю",
    expectedDepth: "medium",
    expectedReason: "uncertainty_in_process",
  },
  {
    name: "10. work arc → пока не понятно → uncertainty_in_process",
    history: buildHistory([
      ["Ну вот я и работаю как всегда", "..."],
      ["Но работа меня выматывает", "..."],
    ]),
    message: "Пока не понятно",
    expectedDepth: "medium",
    expectedReason: "uncertainty_in_process",
    oldDepth: "brief",
  },
];

let failed = 0;

console.log("=== responseBudget depth router ===\n");

for (const c of cases) {
  const analysis = analyzeResponseDepth(c.message, "normal", c.history);
  const oldDepth =
    c.oldDepth ?? detectResponseDepthOld(c.message, "normal", c.history);

  const depthOk = analysis.depth === c.expectedDepth;
  const reasonOk = !c.expectedReason || analysis.depthReason === c.expectedReason;
  const pass = depthOk && reasonOk;

  console.log(`${pass ? "PASS" : "FAIL"}: ${c.name}`);
  console.log(
    `  depth: ${analysis.depth} (expected ${c.expectedDepth}) | old: ${oldDepth}`
  );
  console.log(
    `  reason: ${analysis.depthReason}` +
      (c.expectedReason ? ` (expected ${c.expectedReason})` : "")
  );
  console.log(
    `  meta: recentUserTurns=${analysis.recentUserTurns} emotionalMomentum=${analysis.emotionalMomentum} openFigure=${analysis.openFigure.isOpen}`
  );

  if (!pass) {
    failed++;
    console.log(`  message: ${JSON.stringify(c.message)}`);
  }
  console.log("");
}

// Sanity: detectResponseDepth matches analyzeResponseDepth.depth
const sanityHistory = buildHistory([["Мне грустно", "..."]]);
const msg = "Не знаю";
if (detectResponseDepth(msg, "normal", sanityHistory) !== analyzeResponseDepth(msg, "normal", sanityHistory).depth) {
  failed++;
  console.log("FAIL: detectResponseDepth wrapper mismatch");
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log("All cases passed.");
