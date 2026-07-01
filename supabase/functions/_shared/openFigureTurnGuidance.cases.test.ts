/**
 * Open figure turn guidance — unit cases.
 * Run: npx tsx supabase/functions/_shared/openFigureTurnGuidance.cases.test.ts
 */

import { analyzeOpenFigure } from "./responseDepthTrajectory.ts";
import { analyzeEmotionalTrajectory } from "./responseDepthTrajectory.ts";
import {
  buildOpenFigureTurnGuidance,
  buildOpenFigureTurnGuidanceBlock,
  openFigureGuidanceInjected,
} from "./openFigureTurnGuidance.ts";
import { CLOSED_OPEN_FIGURE } from "./responseDepthTrajectory.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function openFigureFor(message: string) {
  const trajectory = analyzeEmotionalTrajectory(message, []);
  return analyzeOpenFigure({
    message,
    recentHistory: [],
    safetyCategory: "normal",
    trajectory,
  });
}

// 1. emotional
const emotional = openFigureFor("устала");
assert(emotional.isOpen && emotional.kind === "body", "устала should open body");
const emotionalBlock = buildOpenFigureTurnGuidance({
  openFigure: emotional,
  depthReason: "open_figure",
  safetyCategory: "normal",
});
assert(!!emotionalBlock, "emotional: expected guidance");
console.log("✓ guidance for openFigure emotional/body");

// 2. relational
const relational = openFigureFor("он молчит уже третий день");
assert(relational.isOpen && relational.kind === "relational", "relational open");
const relationalBlock = buildOpenFigureTurnGuidance({
  openFigure: relational,
  depthReason: "open_figure",
  safetyCategory: "normal",
});
assert(!!relationalBlock, "relational: expected guidance");
assert(
  relationalBlock!.includes("отношенческий момент"),
  "relational: kind focus missing"
);
console.log("✓ guidance for openFigure relational");

// 3. no questionnaire phrasing
for (const block of [emotionalBlock!, relationalBlock!]) {
  assert(
    !/обязательно\s+задай\s+вопрос/i.test(block),
    "must not contain questionnaire phrasing"
  );
}
console.log('✓ guidance does not contain "обязательно задай вопрос"');

// 4. open-figure contact guidance (base invariant)
const baseOnly = buildOpenFigureTurnGuidanceBlock({
  isOpen: true,
  kind: "unknown",
  intensity: "medium",
  confidence: "low",
  trigger: "short_emotional",
  evidence: [],
});
assert(
  /ещё\s+не\s+нашла\s+места\s+в\s+разговоре/i.test(baseOnly),
  "must describe open figure not yet placed"
);
assert(
  /остаётся\s+в\s+контакте\s+с\s+ней/i.test(baseOnly),
  "must keep response in contact"
);
assert(
  /помогает\s+ей\s+продолжиться/i.test(baseOnly),
  "must help figure continue"
);
assert(
  /не\s+превращай\s+активную\s+фигуру\s+в\s+мягкий\s+финал/i.test(baseOnly),
  "must forbid soft final"
);
assert(
  /форма\s+ответа\s+выбирается\s+по\s+текущему\s+процессу/i.test(baseOnly),
  "must allow process-appropriate form"
);
console.log("✓ guidance describes open figure contact continuation");

// 4b. risky wording removed from base
const banned = [
  "Сделай один ход",
  "один ход",
  "один шаг",
  "одна фраза",
  "мягкое зеркало",
];
for (const phrase of banned) {
  assert(!baseOnly.toLowerCase().includes(phrase.toLowerCase()), `base must not contain: ${phrase}`);
}
console.log("✓ base guidance excludes risky one-move / mirror-menu wording");

// 5. max one question
for (const block of [emotionalBlock!, relationalBlock!]) {
  assert(/максимум\s+один\s+вопрос/i.test(block), "must cap at one question");
}
console.log("✓ guidance contains max-one-question rule");

// 6. exclusions
assert(
  buildOpenFigureTurnGuidance({
    openFigure: CLOSED_OPEN_FIGURE,
    depthReason: "greeting_short",
    safetyCategory: "normal",
  }) === null,
  "closed figure → no guidance"
);
assert(
  buildOpenFigureTurnGuidance({
    openFigure: emotional,
    depthReason: "explicit_closure",
    safetyCategory: "normal",
  }) === null,
  "explicit_closure → no guidance"
);
assert(
  buildOpenFigureTurnGuidance({
    openFigure: emotional,
    depthReason: "open_figure",
    safetyCategory: "crisis",
  }) === null,
  "crisis safety → no guidance"
);
assert(
  buildOpenFigureTurnGuidance({
    openFigure: emotional,
    depthReason: "safety_brief",
    safetyCategory: "boundary_pressure",
  }) === null,
  "safety_brief → no guidance"
);
assert(
  !openFigureGuidanceInjected({
    openFigure: emotional,
    depthReason: "explicit_closure",
    safetyCategory: "normal",
  }),
  "injected=false for closure"
);
console.log("✓ no guidance for closure / crisis / safety brief / closed");

// Block builder without guards
const rawBlock = buildOpenFigureTurnGuidanceBlock({
  isOpen: true,
  kind: "emotional",
  intensity: "medium",
  confidence: "low",
  trigger: "short_emotional",
  evidence: [],
});
assert(
  rawBlock.includes("открытая фигура"),
  "block builder should return guidance text"
);
console.log("✓ buildOpenFigureTurnGuidanceBlock returns core block");

const arcContinuationBlock = buildOpenFigureTurnGuidanceBlock({
  isOpen: true,
  kind: "unknown",
  intensity: "medium",
  confidence: "low",
  trigger: "arc_continuation",
  evidence: ["arc_continuation"],
});
assert(
  /продолжение\s+дуги/i.test(arcContinuationBlock),
  "arc_continuation must use continuation guidance"
);
assert(
  /не спрашивай.*о чём поговорим/i.test(arcContinuationBlock),
  "arc_continuation guidance must forbid generic topic reset"
);
assert(
  !/открытая фигура ещё не нашла места/i.test(arcContinuationBlock),
  "arc_continuation should not use default open-figure opener"
);
console.log("✓ arc_continuation uses thread-pickup guidance");

console.log("\nAll openFigureTurnGuidance cases passed.");
