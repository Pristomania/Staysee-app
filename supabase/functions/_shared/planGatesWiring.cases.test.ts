/**
 * The free plan's closed doors on the server: no memory between conversations, no weekly reflection (dynamics), no
 * pictures. Source-level wiring checks over the places that decide, plus the pure rule.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/planGatesWiring.cases.test.ts
 *
 * Memory of the conversation itself (the dialogue memory) keeps working on every plan: it is not a feature of a plan.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { crossMemoryActive } from "./plans.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const chat = read("staysee-chat/index.ts");
const weekly = read("weekly-reflection/index.ts");
const clientErrors = readFileSync(new URL("../../../src/lib/ai/client.ts", import.meta.url), "utf8");

describe("the rule", () => {
  it("memory between conversations works only when the plan has it AND the person has not switched it off", () => {
    assert.equal(crossMemoryActive("free", true), false, "free plan: never");
    assert.equal(crossMemoryActive("basic", true), true);
    assert.equal(crossMemoryActive("premium", true), true);
    assert.equal(crossMemoryActive("basic", false), false, "the person's own switch still works");
    assert.equal(crossMemoryActive("premium", false), false);
    assert.equal(crossMemoryActive(undefined, true), false, "an unknown plan is the free one");
  });
});

describe("the chat", () => {
  it("builds nothing from other conversations for a plan without that memory", () => {
    assert.match(chat, /import \{[^}]*crossMemoryActive[^}]*isFeatureAvailable[^}]*\} from "\.\.\/_shared\/plans\.ts"|import \{[^}]*isFeatureAvailable[^}]*crossMemoryActive[^}]*\} from "\.\.\/_shared\/plans\.ts"/);
    // the profile facts (legacy memory items) are not given to the prompt
    assert.match(chat, /crossMemoryActive\(userTier, true\) \? packet\.memoryItems : \[\]/);
    // the lifecycle memory is not read...
    assert.match(chat, /if \(crossMemoryActive\(userTier, crossMemoryOnForRead\)\)/);
    // ...and, which also saves the money of the model call, not written
    assert.match(chat, /const crossMemoryOnForWrite = crossMemoryActive\(\s*userTier,\s*await fetchConversationCrossMemoryEnabled/);
    assert.doesNotMatch(chat, /if \(crossMemoryOnForRead\)/, "no read path that ignores the plan");
  });

  it("refuses pictures on a plan without them, before anything is read or paid", () => {
    const planGate = chat.indexOf('unprocessable("images_not_in_plan")');
    const switchGate = chat.indexOf('unprocessable("images_disabled")');
    const consentGate = chat.indexOf('unprocessable("images_consent_required")');
    assert.ok(planGate > 0, "the refusal exists");
    assert.match(chat, /!isFeatureAvailable\(userTier, "fileAttachments"\)/);
    assert.ok(planGate < switchGate && planGate < consentGate, "the plan is checked first");
  });
});

describe("the weekly reflection", () => {
  it("is closed on a plan without dynamics", () => {
    assert.match(weekly, /isFeatureAvailable\(rate\.tier, "conversationDynamics"\)/);
    assert.match(weekly, /error: "not_in_plan"/);
    assert.match(weekly, /status: 403/);
    const planCheck = weekly.indexOf('isFeatureAvailable(rate.tier, "conversationDynamics")');
    const dbRead = weekly.indexOf('.from("conversations")');
    assert.ok(planCheck > 0 && planCheck < dbRead, "checked before the conversation is read");
  });
});

describe("the app", () => {
  it("has a plain line for the picture refusal", () => {
    assert.match(clientErrors, /images_not_in_plan:\s*'[^']*оплат[^']*'/);
  });
});
