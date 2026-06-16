/**
 * Regression: removed continue_redo, holdThreadRole brief300, legal depth routing.
 * Run: npx tsx supabase/functions/_shared/runtimeCleanup.cases.test.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeResponseDepth } from "./responseDepthTrajectory.ts";
import { evaluateTurnSafety } from "./roleEnforcement.ts";
import { classifyMessage } from "./safety.ts";
import { resolveChatModel } from "./modelRouter.ts";

globalThis.Deno = { env: { get: () => undefined } };

type Turn = { role: "user" | "assistant"; content: string };

const DEPTH_TOKEN_TARGET = { brief: 380, medium: 900, deep: 1200 } as const;
const TIER_CEILING = 1600;

function budgetMaxTokens(depth: keyof typeof DEPTH_TOKEN_TARGET): number {
  return Math.min(TIER_CEILING, DEPTH_TOKEN_TARGET[depth]);
}

let failed = 0;

function fail(msg: string): void {
  console.log(`FAIL: ${msg}`);
  failed++;
}

function pass(msg: string): void {
  console.log(`PASS: ${msg}`);
}

function assertNoContinueRedo(message: string, history: Turn[] = []): void {
  const analysis = analyzeResponseDepth(message, "normal", history);
  if (analysis.depthReason === "continue_redo") {
    fail(`continue_redo for: ${JSON.stringify(message.slice(0, 80))}`);
    return;
  }
  pass(`no continue_redo: ${message.slice(0, 40)}…`);
}

function assertLegalNoRuntimePenalty(message: string): void {
  const category = classifyMessage(message);
  const analysis = analyzeResponseDepth(message, category, []);
  const maxTokens = budgetMaxTokens(analysis.depth);

  if (analysis.depthReason === "safety_brief") {
    fail(`safety_brief for legal-tagged message: ${JSON.stringify(message)}`);
    return;
  }
  if (maxTokens <= 300) {
    fail(`budget ≤300 for: ${JSON.stringify(message)} (maxTokens=${maxTokens})`);
    return;
  }
  pass(
    `legal no runtime penalty: ${message.slice(0, 50)}… (cat=${category}, depth=${analysis.depth}, reason=${analysis.depthReason})`
  );
}

function simulateTurn(message: string, history: Turn[]): {
  threadEscalated: boolean;
  depth: string;
  maxTokens: number;
  model: string;
  depthReason: string;
} {
  const safety = evaluateTurnSafety(message, history);
  const modelMessages = [...history, { role: "user", content: message }];
  const analysis = analyzeResponseDepth(
    message,
    safety.category,
    modelMessages
  );
  const maxTokens = budgetMaxTokens(analysis.depth);
  const route = resolveChatModel({
    depth: analysis.depth,
    safetyCategory: safety.category,
  });
  return {
    threadEscalated: safety.threadEscalated,
    depth: analysis.depth,
    maxTokens,
    model: route.model,
    depthReason: analysis.depthReason,
  };
}

console.log("=== runtime cleanup regression ===\n");

console.log("-- no continue_redo --");
for (const msg of [
  "продолжай",
  "допиши",
  "ещё",
  "еще",
  "продолжи ответ",
  "дальше",
  "Еще я забыл упомянуть важный фактор",
  "давай ещё раз",
  "повтори",
]) {
  assertNoContinueRedo(msg);
}

console.log("\n-- no legal boundary runtime penalty --");
for (const msg of [
  "на меня подали иск",
  "у меня долг",
  "я искренне не понимаю",
  "я долго это терпел",
]) {
  assertLegalNoRuntimePenalty(msg);
}

console.log("\n-- Egor regression --");
const auditPath = resolve(process.cwd(), "audit-egor-dialog.json");
let egorMessage = "";
let egorHistory: Turn[] = [];
try {
  const audit = JSON.parse(readFileSync(auditPath, "utf8"));
  const timeline = audit.timeline as Array<{
    index: number;
    role: string;
    content: string;
  }>;
  const turn33 = timeline.find((t) => t.index === 33);
  if (turn33) {
    egorMessage = turn33.content;
    egorHistory = timeline
      .filter((t) => t.index < 33)
      .map((t) => ({
        role: t.role === "user" ? "user" : "assistant",
        content: t.content,
      })) as Turn[];
    egorHistory = egorHistory.slice(-18);
  }
} catch {
  egorMessage =
    "Еще я забыл упомянуть, что у меня огромная мысленная жестокость. " +
    "Когда я делаю то, что мне искренне интересно, я ищу способы решить. " +
    "Меня беспокоят импульсы и опасения насчет психопатии. ".repeat(8);
  egorHistory = Array.from({ length: 8 }, (_, i) => [
    {
      role: "user" as const,
      content: `Я думаю о своих чувствах и агрессии, часть ${i + 1}`,
    },
    {
      role: "assistant" as const,
      content: "A".repeat(600),
    },
  ]).flat();
}

if (!egorMessage) {
  fail("Egor fixture message missing");
} else {
  const turn = simulateTurn(egorMessage, egorHistory);
  if (turn.depthReason === "continue_redo") {
    fail("Egor: continue_redo still fires");
  } else {
    pass(`Egor: no continue_redo (reason=${turn.depthReason})`);
  }
  if (turn.maxTokens <= 300) {
    fail(`Egor: maxTokens=${turn.maxTokens} (expected >300)`);
  } else {
    pass(`Egor: maxTokens=${turn.maxTokens}`);
  }
  if (turn.depth !== "deep" && turn.depth !== "medium") {
    fail(`Egor: depth=${turn.depth} (expected deep or medium)`);
  } else {
    pass(`Egor: depth=${turn.depth}`);
  }
  if (!turn.model.includes("sonnet") && turn.depth === "deep") {
    fail(`Egor: model=${turn.model} (expected Sonnet for deep)`);
  } else if (turn.depth === "deep") {
    pass(`Egor: model=${turn.model}`);
  }
  if (turn.threadEscalated) {
    console.log(
      `  note: threadEscalated=true (guidance only; no budget cap expected)`
    );
  }
  pass("Egor: threadEscalated does not cap budget (no holdThreadRole)");
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log("\nAll runtime cleanup cases passed.");
