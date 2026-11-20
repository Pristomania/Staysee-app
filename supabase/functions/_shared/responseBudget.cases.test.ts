/**
 * The token budget of a reply (the rule of 20.11.2026: nothing is decided by the words of the message).
 * Run: npx tsx supabase/functions/_shared/responseBudget.cases.test.ts
 *
 * The ceiling of a reply is the ceiling of the tier, whatever the message says; a continuation gets a shorter budget. The "short /
 * medium / deep" depth that used to be read off the wording of the message is gone.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  continuationTokenBudget,
  OUTPUT_TOKEN_CEILING_GUIDANCE,
  responseTokenCeiling,
} from "./responseBudget.ts";
import * as responseBudget from "./responseBudget.ts";

describe("the ceiling of a reply is the ceiling of the tier", () => {
  it("free 1200, basic 1600, premium 2000", () => {
    assert.equal(responseTokenCeiling("free"), 1200);
    assert.equal(responseTokenCeiling("basic"), 1600);
    assert.equal(responseTokenCeiling("premium"), 2000);
  });

  it("a continuation gets 55% of the ceiling, never less than 280 and never more than the ceiling", () => {
    assert.equal(continuationTokenBudget("free"), 660);
    assert.equal(continuationTokenBudget("basic"), 880);
    assert.equal(continuationTokenBudget("premium"), 1100);
  });
});

describe("the model is told the ceiling is a boundary, not a length to fill", () => {
  it("keeps its wording", () => {
    assert.ok(OUTPUT_TOKEN_CEILING_GUIDANCE.includes("ceiling is a boundary, not a requested response length"));
  });
});

describe("the depth read off the words is gone and must not come back", () => {
  it("has no function that takes the message and returns a budget", () => {
    for (const gone of ["computeResponseBudget", "analyzeResponseDepth", "detectResponseDepth", "analyzeEmotionalTrajectory"]) {
      assert.equal(gone in responseBudget, false, `${gone} must not exist`);
    }
  });
});
