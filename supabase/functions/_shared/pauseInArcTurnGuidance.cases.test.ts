/**
 * Pause-in-arc turn guidance — unit cases.
 * Run: npx tsx supabase/functions/_shared/pauseInArcTurnGuidance.cases.test.ts
 */

import {
  analyzeEmotionalTrajectory,
  analyzeOpenFigure,
  analyzeResponseDepth,
  type ChatTurn,
} from "./responseDepthTrajectory.ts";
import {
  buildExplicitClosureTurnGuidance,
  explicitClosureGuidanceInjected,
} from "./explicitClosureTurnGuidance.ts";
import {
  PAUSE_IN_ARC_TURN_GUIDANCE_BLOCK,
  buildPauseInArcTurnGuidance,
  isPauseDeparturePhrase,
  pauseInArcGuidanceInjected,
  resolveShortAfterEmotional,
} from "./pauseInArcTurnGuidance.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function buildEmotionalArcHistory(): ChatTurn[] {
  return [
    {
      role: "user",
      content:
        "Меня накрывает страх перед ответственностью. Я должна принять решение, и от этого мандраж.",
    },
    { role: "assistant", content: "Похоже, это решение важно для тебя." },
    { role: "user", content: "И это пугает." },
    { role: "assistant", content: "Что именно тебя пугает?" },
  ];
}

function arcInput(message: string, history = buildEmotionalArcHistory()) {
  const trajectory = analyzeEmotionalTrajectory(message, history);
  const analysis = analyzeResponseDepth(message, "normal", history);
  const openFigure = analyzeOpenFigure({
    message,
    recentHistory: history,
    safetyCategory: "normal",
    trajectory,
  });
  return {
    message,
    depthReason: analysis.depthReason,
    openFigure,
    emotionalMomentum: analysis.emotionalMomentum,
    shortAfterEmotional: trajectory.shortAfterEmotional,
    recentHistory: history,
    safetyCategory: "normal" as const,
  };
}

// 1. Emotional arc + "Я пока пойду"
{
  const input = arcInput("Я пока пойду");
  assert(isPauseDeparturePhrase("Я пока пойду"), "pause phrase");
  assert(
    input.depthReason !== "explicit_closure",
    `must not be explicit_closure, got ${input.depthReason}`
  );
  const guidance = buildPauseInArcTurnGuidance(input);
  assert(!!guidance, "expected pause-in-arc guidance");
  assert(pauseInArcGuidanceInjected(input), "guidanceInjected");
  console.log('✓ emotional arc + "Я пока пойду" → guidance fires');
}

// 2. Emotional arc + "пока"
{
  const input = arcInput("пока");
  assert(isPauseDeparturePhrase("пока"), "пока is pause phrase");
  assert(input.depthReason !== "explicit_closure", "blocked explicit_closure");
  assert(!!buildPauseInArcTurnGuidance(input), "expected guidance");
  console.log('✓ emotional arc + "пока" → guidance fires');
}

// 3. Open figure + "на минуту отойду"
{
  const history: ChatTurn[] = [
    { role: "user", content: "Меня накрывает страх." },
    { role: "assistant", content: "..." },
  ];
  const message = "на минуту отойду";
  const trajectory = analyzeEmotionalTrajectory(message, history);
  const openFigure = analyzeOpenFigure({
    message,
    recentHistory: history,
    safetyCategory: "normal",
    trajectory,
  });
  const analysis = analyzeResponseDepth(message, "normal", history);
  const input = {
    message,
    depthReason: analysis.depthReason,
    openFigure,
    emotionalMomentum: analysis.emotionalMomentum,
    shortAfterEmotional: trajectory.shortAfterEmotional,
    recentHistory: history,
    safetyCategory: "normal" as const,
  };
  assert(openFigure.isOpen || trajectory.shortAfterEmotional, "open/emotional context");
  assert(!!buildPauseInArcTurnGuidance(input), "expected guidance for на минуту отойду");
  console.log('✓ open figure + "на минуту отойду" → guidance fires');
}

// 4. Empty/neutral chat + "пока"
{
  const history: ChatTurn[] = [];
  const message = "пока";
  const analysis = analyzeResponseDepth(message, "normal", history);
  assert(analysis.depthReason === "explicit_closure", "neutral пока → explicit_closure");
  const input = {
    message,
    depthReason: analysis.depthReason,
    openFigure: analysis.openFigure,
    emotionalMomentum: analysis.emotionalMomentum,
    shortAfterEmotional: false,
    recentHistory: history,
    safetyCategory: "normal" as const,
  };
  assert(!buildPauseInArcTurnGuidance(input), "pause guidance must not fire");
  assert(
    !!buildExplicitClosureTurnGuidance({ depthReason: analysis.depthReason, message }),
    "explicit closure guidance remains"
  );
  console.log('✓ empty/neutral + "пока" → pause guidance off, explicit_closure on');
}

// 5. True explicit closure without open figure
{
  const message = "Пойду спать";
  const history: ChatTurn[] = [];
  const analysis = analyzeResponseDepth(message, "normal", history);
  assert(analysis.depthReason === "explicit_closure", "farewell → explicit_closure");
  assert(!analysis.openFigure.isOpen, "no open figure");
  const input = {
    message,
    depthReason: analysis.depthReason,
    openFigure: analysis.openFigure,
    emotionalMomentum: analysis.emotionalMomentum,
    shortAfterEmotional: false,
    recentHistory: history,
    safetyCategory: "normal" as const,
  };
  assert(!buildPauseInArcTurnGuidance(input), "pause guidance must not fire");
  assert(
    explicitClosureGuidanceInjected({ depthReason: analysis.depthReason, message }),
    "explicit closure path remains"
  );
  console.log("✓ true farewell without open figure → explicit_closure only");
}

// 6. Long emotional message with "потом"
{
  const longMsg =
    "Я потом поняла, что меня пугает не решение, а то, что на мне всё держится";
  assert(!isPauseDeparturePhrase(longMsg), "long emotional потом must not match pause phrase");
  const input = arcInput(longMsg);
  assert(!buildPauseInArcTurnGuidance(input), "guidance must not fire");
  console.log('✓ long emotional "потом" message → guidance off');
}

// 7. Crisis + pause-like phrase
{
  const message = "Я пока пойду, думаю о том чтобы навредить себе";
  const input = {
    ...arcInput(message),
    safetyCategory: "crisis" as const,
  };
  assert(!buildPauseInArcTurnGuidance(input), "crisis must block pause guidance");
  console.log("✓ crisis + pause-like phrase → pause guidance off");
}

// 8. Regression — guidance text guards known failure vectors
{
  const block = PAUSE_IN_ARC_TURN_GUIDANCE_BLOCK;
  assert(/не\s+подводи\s+итог/i.test(block), "guards summary");
  assert(/буду\s+ждать/i.test(block), "forbids буду ждать");
  assert(/я\s+всегда\s+здесь/i.test(block), "forbids я всегда здесь");
  assert(/возвращайся/i.test(block), "forbids возвращайся");
  assert(/без\s+эмоционального\s+удержания/i.test(block), "guards attachment");
  assert(/одно\s+короткое\s+предложение/i.test(block), "length cap");
  console.log("✓ guidance block guards availability/farewell/summary");
}

// 9. No emotional arc — temporary departure still gets pause guidance
{
  const message = "Я пока пойду, вернусь позже.";
  const history: ChatTurn[] = [];
  const analysis = analyzeResponseDepth(message, "normal", history);
  assert(analysis.depthReason !== "explicit_closure", "temporary departure not explicit_closure");
  const input = {
    message,
    depthReason: analysis.depthReason,
    openFigure: analysis.openFigure,
    emotionalMomentum: analysis.emotionalMomentum,
    shortAfterEmotional: false,
    recentHistory: history,
    safetyCategory: "normal" as const,
  };
  assert(isPauseDeparturePhrase(message), "pause phrase");
  assert(!!buildPauseInArcTurnGuidance(input), "pause guidance without open arc");
  console.log('✓ no arc + "Я пока пойду, вернусь позже." → pause guidance');
}

// 10. Pause phrase routing table
{
  const pausePhrases = [
    "я пока пойду",
    "вернусь позже",
    "потом продолжим",
    "мне надо отойти",
  ];
  for (const phrase of pausePhrases) {
    assert(isPauseDeparturePhrase(phrase), `${phrase} is pause departure`);
    const analysis = analyzeResponseDepth(phrase, "normal", []);
    assert(
      analysis.depthReason !== "explicit_closure",
      `${phrase} must not be explicit_closure`
    );
    const input = {
      message: phrase,
      depthReason: analysis.depthReason,
      openFigure: analysis.openFigure,
      emotionalMomentum: analysis.emotionalMomentum,
      shortAfterEmotional: false,
      recentHistory: [],
      safetyCategory: "normal" as const,
    };
    assert(!!buildPauseInArcTurnGuidance(input), `${phrase} → pause guidance`);
  }
  console.log("✓ pause phrase routing table");
}

// 11. Explicit closure phrases stay on closure path
{
  for (const phrase of ["на сегодня всё", "пока"]) {
    const analysis = analyzeResponseDepth(phrase, "normal", []);
    assert(
      analysis.depthReason === "explicit_closure",
      `${phrase} → explicit_closure`
    );
    assert(
      !buildPauseInArcTurnGuidance({
        message: phrase,
        depthReason: analysis.depthReason,
        openFigure: analysis.openFigure,
        emotionalMomentum: analysis.emotionalMomentum,
        shortAfterEmotional: false,
        recentHistory: [],
        safetyCategory: "normal",
      }),
      `${phrase} → pause guidance off`
    );
  }
  console.log("✓ explicit closure phrases unchanged");
}

// Uncertainty exclusion
assert(!isPauseDeparturePhrase("пока не знаю"), "пока не знаю is not pause departure");
console.log('✓ "пока не знаю" excluded');

// resolveShortAfterEmotional helper
{
  const history = buildEmotionalArcHistory();
  assert(
    resolveShortAfterEmotional("Я пока пойду", history),
    "resolveShortAfterEmotional on arc"
  );
  console.log("✓ resolveShortAfterEmotional works");
}

console.log("\nAll pauseInArcTurnGuidance cases passed.");
