/**
 * Process state shadow — unit cases.
 * Run: npx tsx supabase/functions/_shared/processState.cases.test.ts
 */

import { computeProcessState } from "./processState.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function baseInput(
  overrides: Partial<Parameters<typeof computeProcessState>[0]> = {}
) {
  return {
    openFigure: {
      isOpen: false,
      intensity: "low" as const,
      confidence: "low" as const,
    },
    depth: "brief" as const,
    explicitClosure: false,
    uncertainty: false,
    recentUserTurns: 1,
    safetyCategory: "normal" as const,
    ...overrides,
    openFigure: {
      isOpen: false,
      intensity: "low" as const,
      confidence: "low" as const,
      ...(overrides.openFigure ?? {}),
    },
  };
}

function expectState(
  name: string,
  input: Parameters<typeof computeProcessState>[0],
  expected: {
    contact: string;
    movement: string;
    closure: string;
    certainty: string;
  }
) {
  const state = computeProcessState(input);
  assert(state.contact === expected.contact, `${name}: contact`);
  assert(state.movement === expected.movement, `${name}: movement`);
  assert(state.closure === expected.closure, `${name}: closure`);
  assert(state.certainty === expected.certainty, `${name}: certainty`);
  assert(state.source === "structural_shadow", `${name}: source`);
  console.log(`✓ ${name}`);
}

expectState("explicit closure", baseInput({ explicitClosure: true }), {
  contact: "closing",
  movement: "settling",
  closure: "user_closing",
  certainty: "high",
});

expectState(
  "crisis",
  baseInput({ safetyCategory: "crisis" }),
  {
    contact: "active",
    movement: "stuck",
    closure: "system_should_not_close",
    certainty: "low",
  }
);

expectState(
  "openFigure high intensity",
  baseInput({
    openFigure: { isOpen: true, intensity: "high", confidence: "medium" },
    depth: "medium",
  }),
  {
    contact: "active",
    movement: "stuck",
    closure: "system_should_not_close",
    certainty: "low",
  }
);

expectState(
  "openFigure medium intensity",
  baseInput({
    openFigure: { isOpen: true, intensity: "medium", confidence: "medium" },
    depth: "medium",
  }),
  {
    contact: "active",
    movement: "opening",
    closure: "system_should_not_close",
    certainty: "low",
  }
);

expectState(
  "openFigure high confidence",
  baseInput({
    openFigure: { isOpen: true, intensity: "medium", confidence: "high" },
    depth: "medium",
  }),
  {
    contact: "active",
    movement: "opening",
    closure: "system_should_not_close",
    certainty: "medium",
  }
);

expectState(
  "openFigure low confidence",
  baseInput({
    openFigure: { isOpen: true, intensity: "low", confidence: "low" },
    depth: "medium",
  }),
  {
    contact: "active",
    movement: "opening",
    closure: "system_should_not_close",
    certainty: "low",
  }
);

expectState(
  "uncertainty + openFigure",
  baseInput({
    openFigure: { isOpen: true, intensity: "medium", confidence: "high" },
    uncertainty: true,
    depth: "medium",
  }),
  {
    contact: "active",
    movement: "stuck",
    closure: "system_should_not_close",
    certainty: "low",
  }
);

expectState(
  "uncertainty without openFigure",
  baseInput({ uncertainty: true, depth: "medium" }),
  {
    contact: "reduced",
    movement: "opening",
    closure: "none",
    certainty: "low",
  }
);

expectState("neutral default", baseInput({ depth: "medium" }), {
  contact: "reduced",
  movement: "settling",
  closure: "none",
  certainty: "medium",
});

expectState(
  "greeting default",
  baseInput({ depth: "brief", recentUserTurns: 1 }),
  {
    contact: "reduced",
    movement: "settling",
    closure: "none",
    certainty: "medium",
  }
);

const lowTurns = computeProcessState(
  baseInput({ depth: "medium", recentUserTurns: 2 })
);
const highTurns = computeProcessState(
  baseInput({ depth: "medium", recentUserTurns: 6 })
);
assert(
  lowTurns.contact === highTurns.contact &&
    lowTurns.movement === highTurns.movement &&
    lowTurns.closure === highTurns.closure &&
    lowTurns.certainty === highTurns.certainty,
  "recentUserTurns must not change processState"
);
console.log("✓ recentUserTurns does not create interpretation");

expectState(
  "explicit closure beats openFigure",
  baseInput({
    explicitClosure: true,
    openFigure: { isOpen: true, intensity: "high", confidence: "high" },
  }),
  {
    contact: "closing",
    movement: "settling",
    closure: "user_closing",
    certainty: "high",
  }
);

expectState(
  "crisis beats openFigure",
  baseInput({
    safetyCategory: "crisis",
    openFigure: { isOpen: true, intensity: "high", confidence: "high" },
  }),
  {
    contact: "active",
    movement: "stuck",
    closure: "system_should_not_close",
    certainty: "low",
  }
);

console.log("\nAll processState cases passed.");
