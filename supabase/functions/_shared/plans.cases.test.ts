/**
 * The tariff constructor: one table of what each plan includes (supabase/functions/_shared/plans.ts), its mirror for
 * the app (src/lib/plans.ts), and everything that must say the same: the reply ceilings the chat really uses, the
 * limits the database enforces (migration 087), the tariffs page of the site.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/plans.cases.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { describe, it } from "node:test";

// cost.ts (and its transitive Edge imports) use Deno-style `npm:` specifiers; remap them for local tsx.
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier === "string" && specifier.startsWith("npm:")) {
    const rest = specifier.slice(4);
    const bare = rest.startsWith("@") ? "@" + rest.slice(1).split("@")[0] : rest.split("@")[0];
    return nextResolve(bare, context);
  }
  return nextResolve(specifier, context);
}
`)}`,
);
const g = globalThis as typeof globalThis & { Deno?: { env: { get: (key: string) => string | undefined } } };
if (!g.Deno) g.Deno = { env: { get: () => undefined } };

const server = await import("./plans.ts");
const client = await import("../../../src/lib/plans.ts");
const { TIER_CONFIG } = await import("./cost.ts");
const { TARIFFS } = await import("../../../scripts/lib/site-pages.mjs");

const { PLANS, planFor, isFeatureAvailable, normalizePlanId, PLAN_FEATURES, VOICE_LEVELS, voiceInputFor, monthsPhrase } = server;
const { CALM_ERRORS } = await import("./cost.ts");

describe("what each plan includes", () => {
  it("free: one conversation, 1200-token replies, typing only, no cross-conversation memory, no dynamics, no file attachments", () => {
    const free = PLANS.free;
    assert.equal(free.maxConversations, 1);
    assert.equal(free.maxTokensOutput, 1200);
    assert.deepEqual(free.features, { crossMemory: false, conversationDynamics: false, fileAttachments: false });
    assert.equal(free.voiceInput, "none");
    assert.equal(free.messages, 50);
    assert.equal(free.priceRub, 0);
  });

  it("basic: three conversations, 1600-token replies, memory, dynamics, voice and file attachments", () => {
    const basic = PLANS.basic;
    assert.equal(basic.maxConversations, 3);
    assert.equal(basic.maxTokensOutput, 1600);
    assert.deepEqual(basic.features, { crossMemory: true, conversationDynamics: true, fileAttachments: true });
    assert.equal(basic.voiceInput, "device", "the cheap voice input that works on the device today");
    assert.deepEqual([basic.priceRub, basic.periodDays, basic.messages], [1990, 30, 400]);
  });

  it("premium: six conversations, 2000-token replies, everything of basic and the good voice input with AI", () => {
    const premium = PLANS.premium;
    assert.equal(premium.maxConversations, 6);
    assert.equal(premium.maxTokensOutput, 2000);
    assert.deepEqual(premium.features, PLANS.basic.features);
    assert.equal(premium.voiceInput, "ai");
    assert.deepEqual([premium.priceRub, premium.periodDays, premium.messages], [4900, 30, 1000]);
  });

  it("a higher plan never gives less than a lower one", () => {
    const order = ["free", "basic", "premium"] as const;
    for (let i = 1; i < order.length; i += 1) {
      const lower = PLANS[order[i - 1]];
      const higher = PLANS[order[i]];
      assert.ok(higher.maxConversations >= lower.maxConversations, `${order[i]}: conversations`);
      assert.ok(higher.maxTokensOutput >= lower.maxTokensOutput, `${order[i]}: reply ceiling`);
      assert.ok(higher.messages >= lower.messages, `${order[i]}: messages`);
      for (const feature of Object.keys(lower.features) as Array<keyof typeof lower.features>) {
        assert.ok(!lower.features[feature] || higher.features[feature], `${order[i]}: ${feature}`);
      }
      assert.ok(VOICE_LEVELS.indexOf(higher.voiceInput) >= VOICE_LEVELS.indexOf(lower.voiceInput), `${order[i]}: voice input`);
    }
  });

  it("an unknown or missing plan is treated as free, never as a paid one", () => {
    for (const value of [undefined, null, "", "enterprise", "BASIC ", 7]) {
      assert.equal(planFor(value as never).id, "free", String(value));
      assert.equal(isFeatureAvailable(value as never, "voiceInput"), false, String(value));
    }
    assert.equal(normalizePlanId("basic"), "basic");
    assert.equal(planFor("premium").id, "premium");
  });

  it("every feature has a name the app can show, and a locked one can be told apart", () => {
    assert.deepEqual([...PLAN_FEATURES].sort(), ["conversationDynamics", "crossMemory", "fileAttachments", "voiceInput"]);
    assert.equal(isFeatureAvailable("free", "fileAttachments"), false);
    assert.equal(isFeatureAvailable("basic", "fileAttachments"), true);
    assert.equal(isFeatureAvailable("free", "voiceInput"), false, "typing only on the free plan");
    assert.equal(isFeatureAvailable("basic", "voiceInput"), true);
    assert.equal(isFeatureAvailable("premium", "voiceInput"), true);
  });

  it("the good voice input is promised only once it is built: until then premium gets the device one", () => {
    assert.equal(voiceInputFor("free"), "none");
    assert.equal(voiceInputFor("basic"), "device");
    assert.equal(voiceInputFor("premium", true), "ai", "when the AI input exists, premium gets it");
    assert.equal(voiceInputFor("premium", false), "device", "when it does not, premium still has voice");
    assert.equal(voiceInputFor("basic", true), "device", "the AI input is never given to a lower plan");
    assert.equal(voiceInputFor(undefined, true), "none", "an unknown plan is the free one");
    assert.equal(voiceInputFor("premium"), "device", "the AI input is not built yet");
  });
});

describe("months are written correctly", () => {
  it("1 месяц, 2 to 4 месяца, the rest месяцев", () => {
    const expected: Record<number, string> = { 1: "1 месяц", 2: "2 месяца", 3: "3 месяца", 4: "4 месяца", 5: "5 месяцев", 6: "6 месяцев", 11: "11 месяцев", 12: "12 месяцев", 21: "21 месяц", 22: "22 месяца" };
    for (const [count, text] of Object.entries(expected)) assert.equal(monthsPhrase(Number(count)), text, count);
  });

  it("the refusal of the free plan says when the messages come back, from the plans table", () => {
    const months = PLANS.free.renewAfterIdleMonths!;
    assert.ok(CALM_ERRORS.freeUsedUp.includes(`через ${monthsPhrase(months)} после последнего сообщения`), CALM_ERRORS.freeUsedUp);
    assert.ok(CALM_ERRORS.freeUsedUp.startsWith("Бесплатные сообщения закончились."));
  });
});

describe("the chat uses these numbers", () => {
  it("the reply ceilings the chat applies are the plans' ceilings", () => {
    for (const id of ["free", "basic", "premium"] as const) {
      assert.equal(TIER_CONFIG[id].maxTokensOutput, PLANS[id].maxTokensOutput, id);
    }
  });
});

describe("the app's copy of the table is the server's", () => {
  it("is identical", () => {
    assert.deepEqual(client.PLANS, PLANS);
    assert.deepEqual([...client.PLAN_FEATURES], [...PLAN_FEATURES]);
    assert.deepEqual([...client.VOICE_LEVELS], [...VOICE_LEVELS]);
    assert.equal(client.AI_VOICE_BUILT, server.AI_VOICE_BUILT, "the flag that says the AI voice exists is the same on both sides");
    for (const value of [undefined, "free", "basic", "premium", "x"]) {
      assert.equal(client.planFor(value as never).id, planFor(value as never).id);
    }
  });
});

describe("the database and the site say the same", () => {
  const dir = new URL("../../migrations/", import.meta.url);
  const sql = (suffix: string) => {
    const file = readdirSync(dir).find((name) => name.endsWith(suffix));
    assert.ok(file, `migration ${suffix} exists`);
    return readFileSync(new URL(file!, dir), "utf8");
  };

  it("conversations per plan and the premium limits match migration 087", () => {
    const text = sql("_087_plan_features.sql");
    const rooms = (tier: string) => Number(new RegExp(`UPDATE public\\.usage_tier_limits\\s+SET max_conversations\\s*=\\s*(\\d+)\\s+WHERE tier\\s*=\\s*'${tier}'`, "i").exec(text)?.[1]);
    assert.equal(rooms("free"), PLANS.free.maxConversations, "free rooms");
    assert.equal(rooms("basic"), PLANS.basic.maxConversations, "basic rooms");
    const premium = /\(\s*'premium'\s*,\s*'month'\s*,\s*(\d+)\s*,\s*([\d.]+)\s*,\s*(\d+)\s*\)/i.exec(text);
    assert.equal(Number(premium?.[1]), PLANS.premium.messages, "premium messages");
    assert.equal(Number(premium?.[3]), PLANS.premium.maxConversations, "premium rooms");
    assert.equal(Number(premium?.[2]), 24, "premium hidden ceiling, USD");
  });

  it("messages per plan match the limits migrations 085 and 087 enforce", () => {
    const m085 = sql("_085_usage_limits.sql");
    assert.equal(Number(/\(\s*'free'\s*,\s*'lifetime'\s*,\s*(\d+)\s*,/i.exec(m085)?.[1]), PLANS.free.messages);
    assert.equal(Number(/\(\s*'basic'\s*,\s*'month'\s*,\s*(\d+)\s*,/i.exec(m085)?.[1]), PLANS.basic.messages);
  });

  it("the free messages come back after the same number of months in the plans table and in migration 086", () => {
    const text = sql("_086_free_tariff_renewal.sql");
    const months = /SET renew_after_idle_months\s*=\s*(\d+)\s+WHERE tier\s*=\s*'free'/i.exec(text);
    assert.equal(Number(months?.[1]), PLANS.free.renewAfterIdleMonths);
    assert.equal(PLANS.basic.renewAfterIdleMonths, null, "a paid plan renews by its own period, not by idleness");
    assert.equal(PLANS.premium.renewAfterIdleMonths, null);
    assert.equal(TARIFFS.free.renewMonths, PLANS.free.renewAfterIdleMonths, "the site says the same");
  });

  it("the tariffs page of the site shows the same numbers", () => {
    assert.equal(TARIFFS.free.messages, PLANS.free.messages);
    assert.equal(TARIFFS.basic.messages, PLANS.basic.messages);
    assert.equal(TARIFFS.basic.priceRub, PLANS.basic.priceRub);
    assert.equal(TARIFFS.basic.periodDays, PLANS.basic.periodDays);
    assert.equal(TARIFFS.premium.messages, PLANS.premium.messages);
    assert.equal(TARIFFS.premium.priceRub, PLANS.premium.priceRub);
    assert.equal(TARIFFS.premium.periodDays, PLANS.premium.periodDays);
  });

  it("the site and the app agree on every plan's conversations, labels and what is open or closed", () => {
    for (const id of ["free", "basic", "premium"] as const) {
      const site = TARIFFS[id];
      const plan = PLANS[id];
      assert.equal(site.label, plan.label, `${id}: name`);
      assert.equal(site.conversations, plan.maxConversations, `${id}: conversations`);
      assert.deepEqual(
        site.features,
        { ...plan.features, voiceInput: plan.voiceInput !== "none" },
        `${id}: what is open and what is closed`,
      );
    }
  });
});
