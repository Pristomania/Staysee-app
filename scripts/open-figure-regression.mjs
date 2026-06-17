/**
 * Open figure + uncertainty routing regression against production staysee-chat.
 *
 * Run:
 *   npx tsx scripts/open-figure-regression.mjs
 *
 * Optional multi-turn prod history (recommended):
 *   STAYSEE_ALLOW_PROD_TESTS=1 STAYSEE_TEST_USER_ID=<uuid> npx tsx scripts/open-figure-regression.mjs
 *
 * Writes: scripts/open-figure-regression-results.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeResponseDepth } from "../supabase/functions/_shared/responseDepthTrajectory.ts";
import { classifyMessage } from "../supabase/functions/_shared/safety.ts";
import { computeProcessState } from "../supabase/functions/_shared/processState.ts";
import { openFigureGuidanceInjected } from "../supabase/functions/_shared/openFigureTurnGuidance.ts";
import { explicitClosureGuidanceInjected } from "../supabase/functions/_shared/explicitClosureTurnGuidance.ts";
import { uncertaintyGuidanceInjected } from "../supabase/functions/_shared/uncertaintyTurnGuidance.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_PATH = resolve(__dirname, "open-figure-regression-cases.json");
const RESULTS_PATH = resolve(__dirname, "open-figure-regression-results.json");

const DEPTH_RANK = { brief: 0, medium: 1, deep: 2 };

const PREMATURE_OBSERVATION_RE =
  /иногда\s+(?:усталость|достаточно\s+просто|просто\s+приходит)|просто\s+заметить\s+это|иногда\s+достаточно\s+просто/i;
const LIVE_STEP_RE =
  /\?|хочешь|расскаж|что\s+именно|как\s+это|где\s+в\s+теле|между\s+вами|сейчас\s+для\s+тебя|что\s+сейчас|как\s+ты\s+это|может\s+быть,\s+стоит|попробуем|остаться\s+с/i;
const CRISIS_SIGNAL_RE =
  /(?:112|103|911|кризис|не\s+один|не\s+одна|экстренн|горяч|линия\s+доверия|небезопасно)/i;

function loadEnvFile() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

loadEnvFile();

const SUPABASE_URL = (
  process.env.SUPABASE_URL ??
  process.env.VITE_SUPABASE_URL ??
  "https://jnxrildlwvtxhtiwucbt.supabase.co"
).replace(/\/$/, "");
const API_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.VITE_SUPABASE_ANON_KEY ??
  "";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function countQuestions(text) {
  return (text.match(/\?/g) ?? []).length;
}

function hasLiveStep(text) {
  return LIVE_STEP_RE.test(text);
}

function isObservationOnly(text) {
  return PREMATURE_OBSERVATION_RE.test(text) && !hasLiveStep(text);
}

function buildHistory(pairs = []) {
  const out = [];
  for (const [user, assistant] of pairs) {
    out.push({ role: "user", content: user });
    if (assistant) out.push({ role: "assistant", content: assistant });
  }
  return out;
}

function processStateFields(processState) {
  return {
    process_contact: processState.contact,
    process_movement: processState.movement,
    process_closure: processState.closure,
    process_certainty: processState.certainty,
    process_state_source: processState.source,
  };
}

function analyzeRouting(message, history, safetyCategory) {
  const analysis = analyzeResponseDepth(message, safetyCategory, history);
  const guidanceInput = {
    openFigure: analysis.openFigure,
    depthReason: analysis.depthReason,
    safetyCategory,
  };
  const uncertaintyGuidanceOn = uncertaintyGuidanceInjected({
    depthReason: analysis.depthReason,
    message,
    openFigure: { isOpen: analysis.openFigure.isOpen },
  });
  const explicitClosureGuidanceOn = explicitClosureGuidanceInjected({
    depthReason: analysis.depthReason,
    message,
  });
  const processState = computeProcessState({
    openFigure: {
      isOpen: analysis.openFigure.isOpen,
      intensity: analysis.openFigure.intensity,
      confidence: analysis.openFigure.confidence,
    },
    depth: analysis.depth,
    explicitClosure: explicitClosureGuidanceOn,
    uncertainty: uncertaintyGuidanceOn,
    recentUserTurns: analysis.recentUserTurns,
    safetyCategory,
  });

  return {
    depth: analysis.depth,
    depthReason: analysis.depthReason,
    openFigure: analysis.openFigure.isOpen,
    openFigureKind: analysis.openFigure.kind,
    openFigureTrigger: analysis.openFigure.trigger,
    openFigureIntensity: analysis.openFigure.intensity,
    openFigureConfidence: analysis.openFigure.confidence,
    recentUserTurns: analysis.recentUserTurns,
    openFigureGuidanceInjected: openFigureGuidanceInjected(guidanceInput),
    uncertaintyGuidanceInjected: uncertaintyGuidanceOn,
    explicitClosureGuidanceInjected: explicitClosureGuidanceOn,
    safetyCategory,
    processState,
    ...processStateFields(processState),
  };
}

function countDistribution(results, key) {
  const dist = {};
  for (const row of results) {
    const value = row[key];
    dist[value] = (dist[value] ?? 0) + 1;
  }
  return dist;
}

async function chatProd(message, requestId, conversationId, userId) {
  const body = { message, requestId };
  if (conversationId && userId) {
    body.conversationId = conversationId;
    body.userId = userId;
  }

  const res = await fetch(`${SUPABASE_URL}/functions/v1/staysee-chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      Apikey: API_KEY,
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }
  return { status: res.status, data };
}

function evaluateCase(testCase, responseText, routing, httpStatus) {
  const failures = [];
  const expected = testCase.expected ?? {};

  if (httpStatus !== 200) {
    failures.push(`HTTP ${httpStatus}`);
  }

  if (!responseText || responseText.length < 8) {
    failures.push("empty or too short response");
  }

  if (expected.openFigure !== undefined && routing.openFigure !== expected.openFigure) {
    failures.push(
      `openFigure expected ${expected.openFigure}, got ${routing.openFigure}`
    );
  }

  if (expected.depth && routing.depth !== expected.depth) {
    failures.push(`depth expected ${expected.depth}, got ${routing.depth}`);
  }

  if (expected.depthReason && routing.depthReason !== expected.depthReason) {
    failures.push(
      `depthReason expected ${expected.depthReason}, got ${routing.depthReason}`
    );
  }

  if (expected.minDepth) {
    if (DEPTH_RANK[routing.depth] < DEPTH_RANK[expected.minDepth]) {
      failures.push(`depth ${routing.depth} below minDepth ${expected.minDepth}`);
    }
  }

  if (expected.safetyCategory && routing.safetyCategory !== expected.safetyCategory) {
    failures.push(
      `safetyCategory expected ${expected.safetyCategory}, got ${routing.safetyCategory}`
    );
  }

  const questionCount = countQuestions(responseText);
  if (expected.maxQuestions !== undefined && questionCount > expected.maxQuestions) {
    failures.push(
      `questionCount ${questionCount} exceeds maxQuestions ${expected.maxQuestions}`
    );
  }

  const responseLength = responseText.length;
  if (expected.maxResponseLength !== undefined && responseLength > expected.maxResponseLength) {
    failures.push(
      `responseLength ${responseLength} exceeds maxResponseLength ${expected.maxResponseLength}`
    );
  }

  if (routing.depth === "brief" && responseLength > 400) {
    failures.push(`brief depth but responseLength ${responseLength} > 400`);
  }

  if (routing.depth === "medium" && (responseLength < 80 || responseLength > 1200)) {
    failures.push(
      `medium depth but responseLength ${responseLength} outside 80–1200 heuristic band`
    );
  }

  if (expected.requireLiveStep && routing.openFigure && isObservationOnly(responseText)) {
    failures.push("response looks like single observation without live step");
  }

  if (expected.requireCrisisSignals && !CRISIS_SIGNAL_RE.test(responseText)) {
    failures.push("crisis response missing safety signals");
  }

  return {
    passed: failures.length === 0,
    failures,
    questionCount,
    responseLength,
  };
}

async function loadProdTestEnv() {
  try {
    const mod = await import("./lib/prod-test-env.mjs");
    if (process.env.STAYSEE_ALLOW_PROD_TESTS !== "1") return null;
    return mod.assertProdTestAllowed();
  } catch {
    return null;
  }
}

async function runMultiTurnProd(testCase, prodEnv, stamp) {
  const mod = await import("./lib/prod-test-env.mjs");
  const historyPairs = testCase.history ?? [];
  const message = testCase.message;

  let result = null;
  await mod.withTestConversation(
    prodEnv,
    `open-figure-regression ${testCase.id} ${stamp}`,
    async ({ conversationId, headers, testUserId }) => {
      for (const [user, assistant] of historyPairs) {
        await mod.seedMessage(
          prodEnv.url,
          headers,
          conversationId,
          testUserId,
          "user",
          user
        );
        if (assistant) {
          await mod.seedMessage(
            prodEnv.url,
            headers,
            conversationId,
            testUserId,
            "assistant",
            assistant
          );
        }
        await sleep(120);
      }

      const http = await chatProd(
        message,
        `open-figure-regression-${testCase.id}-${stamp}`,
        conversationId,
        testUserId
      );
      result = { http, prodHistory: true };
    }
  );
  return result;
}

async function main() {
  if (!API_KEY) {
    console.error("Missing SUPABASE_SERVICE_ROLE_KEY or VITE_SUPABASE_ANON_KEY");
    process.exit(1);
  }

  const cases = JSON.parse(readFileSync(CASES_PATH, "utf8"));
  const prodEnv = await loadProdTestEnv();
  const stamp = Date.now();
  const results = [];
  let passed = 0;
  let failed = 0;

  console.log(`Open figure regression — ${cases.length} cases`);
  console.log(`Endpoint: ${SUPABASE_URL}/functions/v1/staysee-chat`);
  console.log(
    `Multi-turn prod history: ${prodEnv ? "enabled" : "disabled (routing uses local history only)"}\n`
  );

  for (const testCase of cases) {
    await sleep(prodEnv ? 2000 : 2500);

    const history = buildHistory(testCase.history ?? []);
    const safetyCategory = classifyMessage(testCase.message);
    const routingLocal = analyzeRouting(testCase.message, history, safetyCategory);

    let httpStatus = 0;
    let responseText = "";
    let prodHistoryUsed = false;

    if (testCase.history?.length && prodEnv) {
      const multi = await runMultiTurnProd(testCase, prodEnv, stamp);
      if (multi) {
        httpStatus = multi.http.status;
        responseText = multi.http.data.content ?? multi.http.data.error ?? "";
        prodHistoryUsed = multi.prodHistory;
      }
    } else {
      const http = await chatProd(
        testCase.message,
        `open-figure-regression-${testCase.id}-${stamp}`
      );
      httpStatus = http.status;
      responseText = http.data.content ?? http.data.error ?? "";
    }

    const routing = routingLocal;
    const evaluation = evaluateCase(testCase, responseText, routing, httpStatus);

    const processFields = processStateFields(routing.processState);

    const row = {
      id: testCase.id,
      category: testCase.category,
      message: testCase.message,
      passed: evaluation.passed,
      failures: evaluation.failures,
      httpStatus,
      questionCount: evaluation.questionCount,
      responseLength: evaluation.responseLength,
      response: responseText,
      depth: routing.depth,
      depthReason: routing.depthReason,
      openFigure: routing.openFigure,
      openFigureKind: routing.openFigureKind,
      openFigureTrigger: routing.openFigureTrigger,
      openFigureIntensity: routing.openFigureIntensity,
      openFigureConfidence: routing.openFigureConfidence,
      recentUserTurns: routing.recentUserTurns,
      openFigureGuidanceInjected: routing.openFigureGuidanceInjected,
      uncertaintyGuidanceInjected: routing.uncertaintyGuidanceInjected,
      explicitClosureGuidanceInjected: routing.explicitClosureGuidanceInjected,
      safetyCategory: routing.safetyCategory,
      ...processFields,
      prodHistoryUsed,
      depth_meta: {
        depth: routing.depth,
        depthReason: routing.depthReason,
        recentUserTurns: routing.recentUserTurns,
        open_figure: routing.openFigure,
        open_figure_kind: routing.openFigureKind,
        open_figure_intensity: routing.openFigureIntensity,
        open_figure_confidence: routing.openFigureConfidence,
        open_figure_trigger: routing.openFigureTrigger,
        openFigureGuidanceInjected: routing.openFigureGuidanceInjected,
        uncertaintyGuidanceInjected: routing.uncertaintyGuidanceInjected,
        explicitClosureGuidanceInjected: routing.explicitClosureGuidanceInjected,
        ...processFields,
      },
      expected: testCase.expected,
      evaluatedAt: new Date().toISOString(),
    };

    results.push(row);
    if (row.passed) passed++;
    else failed++;

    console.log(
      `${row.passed ? "PASS" : "FAIL"} ${testCase.id} — depth=${routing.depth} openFigure=${routing.openFigure} process=${row.process_contact}/${row.process_movement} questions=${evaluation.questionCount}`
    );
    if (!row.passed) {
      console.log(`  failures: ${evaluation.failures.join("; ")}`);
    }
  }

  const processSummary = {
    process_contact: countDistribution(results, "process_contact"),
    process_movement: countDistribution(results, "process_movement"),
    process_closure: countDistribution(results, "process_closure"),
    process_certainty: countDistribution(results, "process_certainty"),
    user_closing_cases: results
      .filter((row) => row.process_closure === "user_closing")
      .map((row) => row.id),
    stuck_movement_cases: results
      .filter((row) => row.process_movement === "stuck")
      .map((row) => row.id),
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    endpoint: `${SUPABASE_URL}/functions/v1/staysee-chat`,
    total: cases.length,
    passed,
    failed,
    prodMultiTurnEnabled: !!prodEnv,
    processSummary,
    results,
  };

  writeFileSync(RESULTS_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");

  console.log(`\nWrote ${RESULTS_PATH}`);
  console.log(`Summary: ${passed}/${cases.length} passed, ${failed} failed`);
  console.log("\nProcess state (local shadow):");
  console.log(JSON.stringify(processSummary, null, 2));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
