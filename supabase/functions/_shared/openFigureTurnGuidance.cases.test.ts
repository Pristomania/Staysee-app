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

// 4. open-figure contact guidance
for (const block of [emotionalBlock!, relationalBlock!]) {
  assert(
    /ещё\s+не\s+нашла\s+места\s+в\s+разговоре/i.test(block),
    "must describe open figure not yet placed"
  );
  assert(
    /один\s+ход,\s+который\s+поддерживает\s+контакт/i.test(block),
    "must request one contact-supporting move"
  );
}
console.log("✓ guidance describes open figure and one contact move");

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

console.log("\nAll openFigureTurnGuidance cases passed.");
