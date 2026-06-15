/**
 * Prod-like smoke: BASE + runtime layers (no DB context).
 * Run: npx tsx scripts/runtime-prodlike-smoke.ts
 */
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildSurgery1BasePrompt, SURGERY1_LAYER_ID } from "../supabase/functions/_shared/surgery1Prompt.ts";
import { evaluateTurnSafety } from "../supabase/functions/_shared/roleEnforcement.ts";
import { analyzeResponseDepth } from "../supabase/functions/_shared/responseDepthTrajectory.ts";
import {
  buildUncertaintyTurnGuidance,
  uncertaintyGuidanceInjected,
} from "../supabase/functions/_shared/uncertaintyTurnGuidance.ts";
import {
  buildExplicitClosureTurnGuidance,
  explicitClosureGuidanceInjected,
} from "../supabase/functions/_shared/explicitClosureTurnGuidance.ts";
import { buildTimeGapPrompt } from "../supabase/functions/_shared/timeGap.ts";
import { isExplicitConversationClosure } from "../supabase/functions/_shared/responseDepthTrajectory.ts";
import { sanitizeHistoryForModel } from "../supabase/functions/_shared/roleGuard.ts";

const envRaw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
const env: Record<string, string> = {};
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const OR_KEY = env.OPENROUTER_API_KEY;
if (!OR_KEY) {
  console.error("OPENROUTER_API_KEY not found in .env");
  process.exit(1);
}

const MODEL = "openai/gpt-4o";
const TEMPERATURE = 0.85;
const BASE = buildSurgery1BasePrompt();

type Turn = { role: "user" | "assistant"; content: string };

function analyze(text: string) {
  const closures: string[] = [];
  if (/это\s+нормально/i.test(text)) closures.push("eto_normalno");
  if (/я\s+(всегда\s+)?здесь/i.test(text)) closures.push("ya_zdes");
  if (/буду\s+рядом|я\s+рядом/i.test(text)) closures.push("ryadom");
  if (/если\s+захочешь/i.test(text)) closures.push("esli_zahochesh");
  if (/верн(ё|е)шься|вернись|возвращайся|позже/i.test(text)) closures.push("off_ramp");
  if (/на\s+сегодня\s+хватит|оставим|закончим/i.test(text)) closures.push("session_close");
  return {
    words: text.split(/\s+/).filter(Boolean).length,
    closures,
    availability: closures.filter((c) =>
      ["ya_zdes", "ryadom", "esli_zahochesh"].includes(c),
    ),
    hasQuestion: /\?/.test(text),
    figure: /(замеча|интересн|сейчас|непривычн|ново|фигур|ощущ|происход)/i.test(text),
    therapy: /это\s+нормально|абсолютно\s+нормально|естественно/i.test(text),
  };
}

function buildSystemPrompt(message: string, history: Turn[]) {
  const safety = evaluateTurnSafety(message, history);
  if (safety.immediateResponse) {
    return {
      systemPrompt: null as string | null,
      immediate: safety.immediateResponse,
      meta: { safety: safety.category },
    };
  }

  const budget = analyzeResponseDepth(message, safety.category, history);
  let systemPrompt = BASE;
  if (safety.systemGuidance) {
    systemPrompt = [systemPrompt, safety.systemGuidance].join("\n\n");
  }
  const timeGap = buildTimeGapPrompt(undefined);
  if (timeGap) systemPrompt = [systemPrompt, timeGap].join("\n\n");

  const uncertaintyOn = uncertaintyGuidanceInjected({
    depthReason: budget.depthReason,
    message,
  });
  const uncertainty = buildUncertaintyTurnGuidance({
    depthReason: budget.depthReason,
    message,
  });
  if (uncertainty) systemPrompt = [systemPrompt, uncertainty].join("\n\n");

  const closureOn = explicitClosureGuidanceInjected({
    depthReason: budget.depthReason,
    message,
  });
  const closure = buildExplicitClosureTurnGuidance({
    depthReason: budget.depthReason,
    message,
  });
  if (closure) systemPrompt = [systemPrompt, closure].join("\n\n");

  return {
    systemPrompt,
    immediate: null as string | null,
    meta: {
      safety: safety.category,
      depth: budget.depth,
      depthReason: budget.depthReason,
      uncertaintyInjected: uncertaintyOn,
      explicitClosureGuidanceInjected: closureOn,
      model: MODEL,
      closureDetector: isExplicitConversationClosure(message),
    },
  };
}

async function callModel(systemPrompt: string, history: Turn[]) {
  const messages = sanitizeHistoryForModel(history);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OR_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://staysee.app",
      "X-Title": "StaySee runtime-prodlike-smoke surgery1-v3-cognitive-v1",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      temperature: TEMPERATURE,
      max_tokens: 900,
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

async function runTurn(message: string, history: Turn[]) {
  const built = buildSystemPrompt(message, history);
  if (built.immediate) {
    return {
      user: message,
      assistant: built.immediate,
      analysis: analyze(built.immediate),
      meta: built.meta,
      immediateSafety: true,
    };
  }
  const assistant = await callModel(built.systemPrompt!, [
    ...history,
    { role: "user", content: message },
  ]);
  return {
    user: message,
    assistant,
    analysis: analyze(assistant),
    meta: built.meta,
    immediateSafety: false,
  };
}

async function runArc(turns: string[]) {
  const history: Turn[] = [];
  const replies = [];
  for (const user of turns) {
    const r = await runTurn(user, history);
    replies.push(r);
    history.push({ role: "user", content: user });
    history.push({ role: "assistant", content: r.assistant });
  }
  return replies;
}

function exitJudgment(user: string, assistant: string, meta: Record<string, unknown>) {
  const a = analyze(assistant);
  const detector = Boolean(meta.closureDetector);
  const warmExit =
    /спокойн|удачи|береги|до\s+встречи|хорош(ий|его)\s+(выбор|сон|день)|отдых/i.test(
      assistant,
    ) && !a.hasQuestion;
  const recognized = detector || warmExit;
  const noHold = !a.availability.length && !/если\s+захочешь/i.test(assistant);
  const noQuestion = !a.hasQuestion;
  return { detector, warmExit, recognized, noHold, noQuestion, ...a };
}

const EXIT_PHRASES = [
  "Пора бежать.",
  "Побежала.",
  "Я побежала.",
  "Побежал.",
  "Я побежал.",
  "Убегаю.",
  "Я убегаю.",
  "Надо идти.",
  "Мне надо идти.",
  "Пойду.",
  "Я пойду.",
  "Пойду спать.",
  "Я пойду спать.",
  "Пойду работать.",
  "Я пойду работать.",
  "Пойду поработаю.",
  "Я пойду поработаю.",
  "Пойду чай пить.",
  "Я пойду чай пить.",
  "Ладно, пойду.",
  "Ладно, я пойду.",
  "До связи.",
  "Увидимся.",
  "На сегодня всё.",
  "На сегодня все.",
  "Мне достаточно.",
  "Достаточно.",
  "Всё, я ушла.",
  "Все, я ушла.",
  "Всё, я пошла.",
  "Все, я пошла.",
  "Ладно, пойду чай пить.",
];

const UNCERTAINTY_PHRASES = [
  "Не знаю.",
  "Даже не знаю.",
  "Пока непонятно.",
  "Наверное.",
  "Посмотрим.",
  "Странно.",
];

async function main() {
  console.log(`Prod-like smoke: ${SURGERY1_LAYER_ID}`);
  console.log(`BASE ${BASE.length} chars + runtime layers\n`);

  const arcA = await runArc([
    "Ну это сильно по-новому.",
    "Даже не знаю.",
    "Наверное да, интересно наблюдать.",
  ]);

  const uncertainty = [];
  for (const msg of UNCERTAINTY_PHRASES) {
    uncertainty.push(await runTurn(msg, []));
  }

  const exits = [];
  for (const msg of EXIT_PHRASES) {
    const r = await runTurn(msg, []);
    exits.push({ ...r, exit: exitJudgment(msg, r.assistant, r.meta as Record<string, unknown>) });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    layerId: SURGERY1_LAYER_ID,
    model: MODEL,
    pipeline: [
      "buildSurgery1BasePrompt",
      "evaluateTurnSafety",
      "analyzeResponseDepth",
      "buildUncertaintyTurnGuidance",
      "buildExplicitClosureTurnGuidance",
      "buildTimeGapPrompt",
      "no memory/context (isolated turns)",
    ],
    arcA,
    uncertainty,
    exits,
  };

  const out = resolve(process.cwd(), "scripts/experiment-v3-cognitive-v1-prodlike-smoke-report.json");
  writeFileSync(out, JSON.stringify(report, null, 2), "utf8");

  console.log("=== ARC A ===");
  for (const r of arcA) {
    console.log(`USER: ${r.user}`);
    console.log(`meta: ${JSON.stringify(r.meta)}`);
    console.log(`AI: ${r.assistant}`);
    console.log(
      `flags: closures=${r.analysis.closures.join(",") || "none"} avail=${r.analysis.availability.join(",") || "none"}\n`,
    );
  }

  console.log("=== EXITS (detector summary) ===");
  let exitPass = 0;
  for (const r of exits) {
    const ok = r.exit.detector && r.exit.noQuestion && r.exit.noHold;
    if (ok) exitPass++;
    console.log(
      `${ok ? "PASS" : "FAIL"} ${r.user} detector=${r.exit.detector} q=${r.exit.hasQuestion} avail=${r.exit.availability.length}`,
    );
  }
  console.log(`\nExits: ${exitPass}/${exits.length} pass detector+noQuestion+noHold`);

  console.log(`\nReport: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
