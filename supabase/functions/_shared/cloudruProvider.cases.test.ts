/**
 * Run: npx tsx supabase/functions/_shared/cloudruProvider.cases.test.ts
 * DeepSeek V4 Pro (main) and Kimi K2.6 (reserve): asked through OpenRouter on the private route now, ready for Cloud.ru after the move.
 * The host follows the model, each model has the right switch for the thinking, the reserve of one is the other one on the same
 * host, the words of the person do not leave Russia on their own once the models are on Cloud.ru, and the founder is told in
 * Telegram when the money is gone.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const env: Record<string, string> = {};
(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: (key: string) => env[key] } };

const {
  APPROVED_MODEL_DEEPSEEK_V4_PRO,
  APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU,
  APPROVED_MODEL_GPT4O,
  APPROVED_MODEL_KIMI_K26,
  APPROVED_MODEL_KIMI_K26_CLOUDRU,
  APPROVED_MODEL_SONNET,
  isApprovedRuntimeModel,
  normalizeApprovedModelId,
} = await import("./approvedModels.ts");
const { CLOUDRU_BASE_URL, hostForModel } = await import("./modelHost.ts");
const { buildChatModelParameters, buildChatModelProviderRoute } = await import("./chatModelParameters.ts");
const { resolveChatModel } = await import("./modelRouter.ts");
const { calculateCostFromTokens } = await import("./openRouterPricing.ts");
const { PROVIDER_ALERT_WINDOW_MS, resetProviderAlertsForTests, sendProviderAlertSafely } = await import("./providerAlert.ts");

let failed = 0;
function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.log(`FAIL: ${message}`);
    failed++;
    return;
  }
  console.log(`PASS: ${message}`);
}

console.log("=== the models and the host ===\n");
assert(APPROVED_MODEL_DEEPSEEK_V4_PRO === "deepseek/deepseek-v4-pro" && APPROVED_MODEL_KIMI_K26 === "moonshotai/kimi-k2.6", "the OpenRouter names of the two models");
assert([APPROVED_MODEL_DEEPSEEK_V4_PRO, APPROVED_MODEL_KIMI_K26, APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU, APPROVED_MODEL_KIMI_K26_CLOUDRU].every(isApprovedRuntimeModel), "all four names (two on OpenRouter, two on Cloud.ru) are approved");
assert(normalizeApprovedModelId("deepseek-ai/deepseek-v4-pro") === APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU, "the Cloud.ru name typed in small letters is the same model");
assert(hostForModel(APPROVED_MODEL_DEEPSEEK_V4_PRO) === "openrouter" && hostForModel(APPROVED_MODEL_KIMI_K26) === "openrouter", "now the two models are asked through OpenRouter");
assert(hostForModel(APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU) === "cloudru" && hostForModel(APPROVED_MODEL_KIMI_K26_CLOUDRU) === "cloudru", "their Cloud.ru names are asked of Cloud.ru");
assert(hostForModel(APPROVED_MODEL_GPT4O) === "openrouter" && hostForModel(APPROVED_MODEL_SONNET) === "openrouter" && hostForModel("openai/gpt-6.1-sol") === "openrouter", "every other approved model stays on OpenRouter");
assert(CLOUDRU_BASE_URL === "https://foundation-models.api.cloud.ru/v1", "the Cloud.ru address");

console.log("\n=== the parameters: the thinking is off ===\n");
for (const model of [APPROVED_MODEL_DEEPSEEK_V4_PRO, APPROVED_MODEL_KIMI_K26]) {
  const p = buildChatModelParameters(model, 0.85);
  assert(p.temperature === 0.85 && JSON.stringify(p.reasoning) === JSON.stringify({ effort: "none" }), `${model}: temperature and reasoning effort none (OpenRouter)`);
}
const cloudDeepseek = buildChatModelParameters(APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU, 0.85);
assert(cloudDeepseek.temperature === 0.85 && cloudDeepseek.reasoning_effort === "none" && !("reasoning" in cloudDeepseek), "DeepSeek V4 Pro on Cloud.ru: reasoning_effort none");
const cloudKimi = buildChatModelParameters(APPROVED_MODEL_KIMI_K26_CLOUDRU, 0.82);
assert(cloudKimi.temperature === 0.82 && cloudKimi.chat_template_kwargs?.thinking === false && !("reasoning_effort" in cloudKimi), "Kimi K2.6 on Cloud.ru: chat_template_kwargs thinking false (reasoning_effort is refused by it)");
assert(JSON.stringify(buildChatModelParameters("openai/gpt-6.1-sol", 0.85)) === JSON.stringify({ reasoning: { effort: "low", exclude: true } }), "Sol is as before");
assert(JSON.stringify(buildChatModelParameters(APPROVED_MODEL_GPT4O, 0.85)) === JSON.stringify({ temperature: 0.85 }), "GPT-4o is as before");

console.log("\n=== the private route (OpenRouter) ===\n");
const deepseekRoute = buildChatModelProviderRoute(APPROVED_MODEL_DEEPSEEK_V4_PRO) as Record<string, unknown>;
assert(deepseekRoute.data_collection === "deny" && deepseekRoute.zdr === true, "DeepSeek V4 Pro: nothing is kept, nothing is trained on (zero data retention)");
const kimiRoute = buildChatModelProviderRoute(APPROVED_MODEL_KIMI_K26) as Record<string, unknown>;
assert(kimiRoute.data_collection === "deny" && kimiRoute.zdr === true && JSON.stringify(kimiRoute.ignore) === JSON.stringify(["Venice"]), "Kimi K2.6: the same, and never Venice (it writes the thinking into the reply)");
assert(JSON.stringify(buildChatModelProviderRoute("openai/gpt-6.1-sol")).includes("azure/eu"), "the route of Sol is as before");

console.log("\n=== the reserve model ===\n");
for (const key of Object.keys(env)) delete env[key];
const flat = { depth: "brief", safetyCategory: "normal", flatOrdinary: true } as const;
env.STAYSEE_CHAT_MODEL = APPROVED_MODEL_DEEPSEEK_V4_PRO;
let route = resolveChatModel(flat);
assert(route.model === APPROVED_MODEL_DEEPSEEK_V4_PRO && route.fallbackModel === APPROVED_MODEL_KIMI_K26, "main DeepSeek V4 Pro: the reserve is Kimi K2.6");
env.STAYSEE_CHAT_MODEL = APPROVED_MODEL_KIMI_K26;
route = resolveChatModel(flat);
assert(route.model === APPROVED_MODEL_KIMI_K26 && route.fallbackModel === APPROVED_MODEL_DEEPSEEK_V4_PRO, "main Kimi K2.6: the reserve is DeepSeek V4 Pro");
env.STAYSEE_CHAT_MODEL = APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU;
route = resolveChatModel(flat);
assert(route.model === APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU && route.fallbackModel === APPROVED_MODEL_KIMI_K26_CLOUDRU, "on Cloud.ru the reserve is the other Cloud.ru model");
env.STAYSEE_CHAT_MODEL = APPROVED_MODEL_DEEPSEEK_V4_PRO;
env.STAYSEE_CHAT_MODEL_FALLBACK = APPROVED_MODEL_SONNET;
route = resolveChatModel(flat);
assert(route.fallbackModel === APPROVED_MODEL_SONNET, "STAYSEE_CHAT_MODEL_FALLBACK sets the reserve by hand");
delete env.STAYSEE_CHAT_MODEL_FALLBACK;
route = resolveChatModel({ depth: "deep", safetyCategory: "normal" });
assert(route.model === APPROVED_MODEL_DEEPSEEK_V4_PRO && route.fallbackModel === APPROVED_MODEL_KIMI_K26, "also on the depth routes the reserve is the other one of the two");
env.STAYSEE_CHAT_MODEL = APPROVED_MODEL_GPT4O;
route = resolveChatModel(flat);
assert(route.model === APPROVED_MODEL_GPT4O && route.fallbackModel === APPROVED_MODEL_SONNET, "any other model keeps its own reserve");
route = resolveChatModel({ depth: "brief", safetyCategory: "normal", requestModel: APPROVED_MODEL_KIMI_K26 });
assert(route.model === APPROVED_MODEL_KIMI_K26 && route.source === "request", "a model may be asked in the request (dev and tests)");

console.log("\n=== the cost ===\n");
assert(Math.abs(calculateCostFromTokens(APPROVED_MODEL_DEEPSEEK_V4_PRO, 1_000_000, 0) - 0.9) < 1e-6, "DeepSeek V4 Pro on OpenRouter: 0.90 dollar per million of input");
assert(Math.abs(calculateCostFromTokens(APPROVED_MODEL_KIMI_K26, 0, 1_000_000) - 3.41) < 1e-6, "Kimi K2.6 on OpenRouter: 3.41 dollars per million of output");
assert(Math.abs(calculateCostFromTokens(APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU, 1_000_000, 0) - 2.033) < 1e-6, "DeepSeek V4 Pro on Cloud.ru: 183 roubles per million at 90 roubles per dollar");
assert(Math.abs(calculateCostFromTokens(APPROVED_MODEL_KIMI_K26_CLOUDRU, 0, 1_000_000) - 8.066) < 1e-6, "Kimi K2.6 on Cloud.ru: 725.9 roubles per million of output");

console.log("\n=== the alert in Telegram ===\n");
const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const sent: string[] = [];
const okFetch = async (url: string, init: { body: string }) => {
  sent.push(`${url.replace(TOKEN, "<token>")} ${JSON.parse(init.body).text}`);
  return { ok: true };
};
resetProviderAlertsForTests();
let result = await sendProviderAlertSafely("balance_empty", { now: 1_000, botToken: TOKEN, chatId: "-1001234567890", fetchImpl: okFetch });
assert(result === true && sent.length === 1 && /закончились деньги/.test(sent[0]) && /api\.telegram\.org\/bot<token>\/sendMessage/.test(sent[0]), "the first alert is sent, with the words about the money");
result = await sendProviderAlertSafely("balance_empty", { now: 1_000 + 60_000, botToken: TOKEN, chatId: "-1001234567890", fetchImpl: okFetch });
assert(result === false && sent.length === 1, "a second alert of the same kind within half an hour is not sent");
result = await sendProviderAlertSafely("key_rejected", { now: 1_000 + 60_000, botToken: TOKEN, chatId: "-1001234567890", fetchImpl: okFetch });
assert(result === true && sent.length === 2 && /ключ/.test(sent[1]), "another kind is sent at once");
result = await sendProviderAlertSafely("balance_empty", { now: 1_000 + PROVIDER_ALERT_WINDOW_MS + 1, botToken: TOKEN, chatId: "-1001234567890", fetchImpl: okFetch });
assert(result === true && sent.length === 3, "after half an hour the alert may be sent again");
resetProviderAlertsForTests();
result = await sendProviderAlertSafely("balance_empty", { now: 5, botToken: "not a token", chatId: "-1001234567890", fetchImpl: okFetch });
assert(result === false && sent.length === 3, "a wrong token sends nothing");
result = await sendProviderAlertSafely("balance_empty", { now: 6, botToken: TOKEN, chatId: "-1001234567890", fetchImpl: async () => { throw new Error("network"); } });
assert(result === false, "a network failure never throws");
assert(!/user|@|\d{5,}/i.test(sent[0].slice(sent[0].indexOf(" ") + 1)), "no user data and no number of an account in the text of the alert");

console.log("\n=== the chat function ===\n");
const chat = readFileSync(resolve("supabase/functions/staysee-chat/index.ts"), "utf8").replace(/\r/g, "");
const WIRING: Array<[string, RegExp]> = [
  ["Cloud.ru is a provider with its own key", /cloudru: \{\s*baseUrl: CLOUDRU_BASE_URL,[\s\S]*?envKey: CLOUDRU_API_KEY_ENV,/],
  ["the host follows the model", /if \(hostForModel\(model\) === "cloudru"\) \{\s*provider = "cloudru";\s*config = PROVIDERS\.cloudru;/],
  ["Cloud.ru gets no OpenRouter fields", /\.\.\.\(provider === "cloudru" \? \{\} : \{ usage: \{ include: true \} \}\)/],
  ["no money or a refused key: the founder is told", /provider === "cloudru" && \(res\.status === 402 \|\| res\.status === 401 \|\| res\.status === 403\)[\s\S]*?sendProviderAlertSafely\(res\.status === 402 \? "balance_empty" : "key_rejected"\)/],
  ["foreign providers answer a Cloud.ru model only by the switch", /hostForModel\(primaryModel\) !== "cloudru" \|\| Deno\.env\.get\("STAYSEE_FOREIGN_FALLBACK"\) === "1"/],
  ["the route of OpenRouter comes from the model", /provider === "openrouter" \? \{ provider: buildChatModelProviderRoute\(model\) \} : \{\}/],
];
for (const [name, pattern] of WIRING) assert(pattern.test(chat), `chat function: ${name}`);

console.log(`\n=== ${failed === 0 ? "All passed" : `${failed} failed`} ===`);
if (failed > 0) process.exit(1);
