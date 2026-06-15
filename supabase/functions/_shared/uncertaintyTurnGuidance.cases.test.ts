/**
 * Uncertainty turn guidance — unit cases.
 * Run: npx tsx supabase/functions/_shared/uncertaintyTurnGuidance.cases.test.ts
 */

import { analyzeResponseDepth } from "./responseDepthTrajectory.ts";
import {
  buildUncertaintyTurnGuidance,
  uncertaintyGuidanceInjected,
} from "./uncertaintyTurnGuidance.ts";
import { isUncertaintyPhrase } from "./responseDepthTrajectory.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type Turn = { role: "user" | "assistant"; content: string };

function buildHistory(pairs: Array<[string, string?]>): Turn[] {
  const out: Turn[] = [];
  for (const [user, assistant] of pairs) {
    out.push({ role: "user", content: user });
    if (assistant) out.push({ role: "assistant", content: assistant });
  }
  return out;
}

interface Expect {
  depth: string;
  depthReason: string;
  uncertaintyGuidanceInjected: boolean;
}

function expectCase(name: string, history: Turn[], message: string, exp: Expect) {
  const analysis = analyzeResponseDepth(message, "normal", history);
  const injected = uncertaintyGuidanceInjected({
    depthReason: analysis.depthReason,
    message,
  });
  const block = buildUncertaintyTurnGuidance({
    depthReason: analysis.depthReason,
    message,
  });

  assert(analysis.depth === exp.depth, `${name}: depth ${analysis.depth} !== ${exp.depth}`);
  assert(
    analysis.depthReason === exp.depthReason,
    `${name}: reason ${analysis.depthReason} !== ${exp.depthReason}`
  );
  assert(
    injected === exp.uncertaintyGuidanceInjected,
    `${name}: guidanceInjected ${injected} !== ${exp.uncertaintyGuidanceInjected}`
  );
  if (exp.uncertaintyGuidanceInjected) {
    assert(!!block, `${name}: expected guidance block`);
    assert(block!.includes("процессная неопределённость"), `${name}: block missing header`);
  } else {
    assert(!block, `${name}: unexpected guidance block`);
  }
  console.log(`✓ ${name}`);
}

// A. Процессная неопределённость — overnight arc
expectCase(
  "A. overnight arc → не знаю",
  buildHistory([
    [
      "Сегодня впервые мужчина ночует у меня дома, но в отдельной комнате.",
      "Новая сцена.",
    ],
    ["Мне непривычно.", "Слышу."],
  ]),
  "не знаю",
  {
    depth: "medium",
    depthReason: "uncertainty_in_process",
    uncertaintyGuidanceInjected: true,
  }
);

// B1. «пока не знаю» с содержательной дугой (голос)
expectCase(
  "B1. voice arc → пока не знаю",
  buildHistory([
    ["Мы обсуждаем, как звучит новый голос StaySee.", "Интересно."],
    ["Мне пока сложно сформулировать.", "..."],
  ]),
  "пока не знаю",
  {
    depth: "medium",
    depthReason: "uncertainty_in_process",
    uncertaintyGuidanceInjected: true,
  }
);

// B2. изолированное «пока не знаю» — strong uncertainty без дуги
expectCase(
  "B2. isolated пока не знаю → uncertainty",
  [],
  "пока не знаю",
  {
    depth: "medium",
    depthReason: "uncertainty_in_process",
    uncertaintyGuidanceInjected: true,
  }
);

// Canonical arc A — turn 2
expectCase(
  "A2. canonical arc → Даже не знаю",
  buildHistory([
    ["Ну это сильно по-новому.", "Расскажи, что именно тебе кажется новым?"],
  ]),
  "Даже не знаю.",
  {
    depth: "medium",
    depthReason: "uncertainty_in_process",
    uncertaintyGuidanceInjected: true,
  }
);

// Soft uncertainty with arc
expectCase(
  "D1. arc → наверное",
  buildHistory([["Мне как-то странно последние дни", "..."]]),
  "Наверное.",
  {
    depth: "medium",
    depthReason: "uncertainty_in_process",
    uncertaintyGuidanceInjected: true,
  }
);

// Soft uncertainty isolated → brief
expectCase(
  "D2. isolated наверное → brief",
  [],
  "Наверное.",
  {
    depth: "brief",
    depthReason: "short_neutral",
    uncertaintyGuidanceInjected: false,
  }
);

// Closure beats uncertainty
expectCase(
  "E1. не знаю + на сегодня всё → closure",
  buildHistory([["Мне тревожно", "..."]]),
  "Не знаю, на сегодня всё",
  {
    depth: "brief",
    depthReason: "explicit_closure",
    uncertaintyGuidanceInjected: false,
  }
);

// C. Настоящее завершение
expectCase(
  "C. на сегодня хватит → no guidance",
  buildHistory([["Мне тревожно", "..."]]),
  "на сегодня хватит",
  {
    depth: "brief",
    depthReason: "explicit_closure",
    uncertaintyGuidanceInjected: false,
  }
);

// Extra patterns
const phraseCases = [
  "пока не знаю",
  "я пока не знаю",
  "да вот не знаю",
  "да вот я и не знаю",
  "даже не знаю",
  "не могу понять",
  "не понимаю пока",
  "сложно понять",
  "неясно",
  "не чувствую пока",
  "не могу почувствовать",
  "пока непонятно",
  "наверное",
  "посмотрим",
  "странно",
];
for (const p of phraseCases) {
  assert(isUncertaintyPhrase(p), `phrase should match: ${p}`);
}
console.log(`✓ ${phraseCases.length} uncertainty phrase patterns`);

assert(!isUncertaintyPhrase("пока"), "пока is closure not uncertainty");
assert(!isUncertaintyPhrase("на сегодня хватит"), "closure excluded");
console.log("✓ closure phrases excluded");

console.log("\nAll uncertaintyTurnGuidance cases passed.");
