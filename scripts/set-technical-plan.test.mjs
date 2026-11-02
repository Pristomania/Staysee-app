import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(new URL("./set-technical-plan.mjs", import.meta.url), "utf8");

describe("the switch of the technical test user's plan", () => {
  it("cannot touch anybody but a technical account", () => {
    assert.match(source, /assertProdTestAllowed\(\)/, "production tests must be allowed explicitly");
    assert.match(source, /\\\.invalid\$/, "the address of the account must end in .invalid (a technical account)");
    assert.match(source, /refusing/, "it says why it refuses");
    // the guard comes before any write
    assert.ok(source.indexOf("refusing:") < source.indexOf('rpc("set_user_plan"'), "the check is made before the plan is changed");
    assert.doesNotMatch(source, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "no person's id is written into the script");
  });

  it("knows only two states: free (a real free account) and premium (the normal state of the technical user)", () => {
    assert.match(source, /\["free", "premium"\]/);
    assert.match(source, /set_user_plan/);
    assert.match(source, /set_unlimited_usage/);
    assert.match(source, /max_conversations_override: plan === "premium" \? 50 : null/);
    assert.match(source, /p_on: plan === "premium"/);
  });

  it("can set how many messages are already used, only on the free plan, within the plan's 50", () => {
    assert.match(source, /--used=/);
    assert.match(source, /plan !== "free"/, "the used count is a thing of the free plan only");
    assert.match(source, /Number\.isInteger\(used\) && used >= 0 && used <= 50/, "a whole number from 0 to 50");
    assert.match(source, /period_requests_used: used/);
    // it never reaches past the plan's own number
    assert.ok(source.indexOf("--used=") < source.indexOf('rpc("set_user_plan"'), "the value is checked before anything is written");
  });

  it("changes only the one row of that user", () => {
    assert.match(source, /user_usage_tiers\?user_id=eq\.\$\{testUserId\}/);
    assert.doesNotMatch(source, /method:\s*"DELETE"/);
  });

  it("can add one pack of bought messages, and always clears the old test packs first", () => {
    assert.match(source, /"--pack"/);
    assert.match(source, /void_message_pack/, "old test packs are voided");
    assert.match(source, /grant_message_pack/, "a new one is granted on request");
    assert.ok(source.indexOf("void_message_pack") < source.indexOf("grant_message_pack"), "clear first, then add");
    assert.match(source, /p_messages: 100/);
    assert.match(source, /if \(wantPack\) throw error/, "only a request for a pack is an error on an older database");
    assert.ok(source.indexOf("refusing:") < source.indexOf("void_message_pack"), "the technical-account check comes before any pack is touched");
  });
});
