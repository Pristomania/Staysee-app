/**
 * Replay exact prod transcript on staging with pipeline trace.
 *
 * Prerequisites:
 *   - scripts/tmp-prod-transcript-*.json from export script
 *   - STAYSEE_REPLY_PIPELINE_TRACE=1 on staging staysee-chat
 *
 * Run:
 *   node scripts/reply-pipeline-exact-prod-replay.mjs
 *   node scripts/reply-pipeline-exact-prod-replay.mjs --transcript=scripts/tmp-prod-transcript-46d61713.json
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  deleteTestConversation,
  loadEnvFile,
  makeServiceHeaders,
} from "./lib/prod-test-env.mjs";

const STAGING_REF = "hdmoetcvlszrdukqpiia";
const STAGING_URL = `https://${STAGING_REF}.supabase.co`;
const STAGING_TEST_USER_ID = "12c823c1-a82b-408c-8179-bc02e8d7e3b1";
const DEFAULT_TRANSCRIPT = resolve(
  process.cwd(),
  "scripts/tmp-prod-transcript-46d61713.json"
);
const OUT_PATH = resolve(process.cwd(), "scripts/reply-pipeline-exact-prod-replay-report.json");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function getStagingServiceKey() {
  const env = loadEnvFile();
  const fromEnv =
    process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY ?? env.STAGING_SUPABASE_SERVICE_ROLE_KEY;
  if (fromEnv?.startsWith("eyJ") && jwtProjectRef(fromEnv) === STAGING_REF) return fromEnv;
  const raw = execSync(`npx supabase projects api-keys --project-ref ${STAGING_REF} -o json`, {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  return JSON.parse(raw).find((k) => k.id === "service_role")?.api_key ?? "";
}

function jwtProjectRef(token) {
  try {
    const part = token.split(".")[1];
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    return JSON.parse(json).ref ?? null;
  } catch {
    return null;
  }
}

function hashContent(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function tailContent(text, n = 120) {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(-n);
}

function isBrokenContact(text) {
  const body = (text ?? "").trim();
  if (!body) return false;
  const dq = (body.match(/"/g) ?? []).length;
  if (dq % 2 === 1) return true;
  const openG = (body.match(/«/g) ?? []).length;
  const closeG = (body.match(/»/g) ?? []).length;
  if (openG !== closeG) return true;
  if (/\([^)]*$/.test(body) || /\[[^\]]*$/.test(body)) return true;
  if (/[—–:,]\s*$/u.test(body)) return true;
  if (!/[.!?…]["')\]]*\s*$/.test(body)) return true;
  return false;
}

function firstChangedStage(trace) {
  const order = [
    "provider_raw_text",
    "adapter_extracted_content",
    "after_auto_continue_merge",
    "after_polish_merged",
    "after_ensure_publishable",
    "after_role_bounded_reply",
    "before_http_response",
  ];
  let prev = null;
  for (const stage of order) {
    const row = trace.find((s) => s.stage === stage);
    if (!row) continue;
    if (prev && prev.contentHash !== row.contentHash) {
      return { from: prev.stage, to: stage, lengthDelta: row.contentLength - prev.contentLength };
    }
    prev = row;
  }
  return null;
}

function stageTable(trace) {
  const names = [
    "provider_raw_text",
    "adapter_extracted_content",
    "after_auto_continue_merge",
    "after_polish_merged",
    "after_ensure_publishable",
    "after_role_bounded_reply",
    "before_http_response",
  ];
  return names
    .map((name) => trace.find((s) => s.stage === name))
    .filter(Boolean)
    .map((s) => ({
      stage: s.stage,
      len: s.contentLength,
      hash: s.contentHash,
      tail: s.tail,
      finishReason: s.finishReason ?? null,
      generationStatus: s.generationStatus ?? null,
      autoContinueUsed: s.autoContinueUsed ?? false,
      finalizeUsed: s.finalizeUsed ?? false,
    }));
}

async function createConversation(serviceKey, userId) {
  const res = await fetch(`${STAGING_URL}/rest/v1/conversations`, {
    method: "POST",
    headers: { ...makeServiceHeaders(serviceKey), Prefer: "return=representation" },
    body: JSON.stringify({
      user_id: userId,
      title: "__TEST__ exact prod transcript replay",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`conversation create ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text)[0]?.id;
}

async function seedHistoricalMessage(headers, conversationId, userId, row) {
  const role = row.role ?? (row.sender === "user" ? "user" : "assistant");
  const payload = {
    conversation_id: conversationId,
    user_id: userId,
    sender: role === "user" ? "user" : "ai",
    role: role === "user" ? "user" : "assistant",
    content: row.content,
    created_at: row.created_at,
  };
  if (row.client_message_id) payload.client_message_id = row.client_message_id;

  const res = await fetch(`${STAGING_URL}/rest/v1/messages`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`seed message ${row.id}: ${res.status} ${err.slice(0, 200)}`);
  }
}

async function replayChat({ serviceKey, conversationId, userId, message, requestId, modelOverride }) {
  const body = { message, conversationId, userId, requestId };
  if (modelOverride) body.model = modelOverride;

  const res = await fetch(`${STAGING_URL}/functions/v1/staysee-chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
      Apikey: serviceKey,
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

  const content = typeof data.content === "string" ? data.content : "";
  const trace = Array.isArray(data._replyPipelineTrace) ? data._replyPipelineTrace : [];
  const http = trace.find((s) => s.stage === "before_http_response") ?? {};

  return {
    httpStatus: res.status,
    content,
    model: data.model ?? null,
    trace,
    finishReason: http.finishReason ?? null,
    generationStatus: http.generationStatus ?? null,
    autoContinueUsed: http.autoContinueUsed ?? false,
    finalizeUsed: http.finalizeUsed ?? false,
  };
}

async function main() {
  const transcriptPath = resolve(process.cwd(), arg("transcript", DEFAULT_TRANSCRIPT));
  if (!existsSync(transcriptPath)) {
    console.error(`Missing transcript: ${transcriptPath}`);
    console.error("Run reply-pipeline-export-prod-transcript.mjs first.");
    process.exit(1);
  }

  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
  const serviceKey = getStagingServiceKey();
  const testUserId =
    process.env.STAYSEE_TEST_USER_ID ?? loadEnvFile().STAYSEE_TEST_USER_ID ?? STAGING_TEST_USER_ID;

  if (!serviceKey) throw new Error("Staging service_role key unavailable");

  const headers = makeServiceHeaders(serviceKey);
  let conversationId = null;

  try {
    conversationId = await createConversation(serviceKey, testUserId);
    console.log(`Staging conversation: ${conversationId}`);
    console.log(`Seeding ${transcript.seedMessages.length} messages...`);

    for (const row of transcript.seedMessages) {
      await seedHistoricalMessage(headers, conversationId, testUserId, row);
    }

    const trigger = transcript.replayTriggerUserMessage;
    const requestId = `exact-replay-${Date.now()}`;
    console.log(`Replaying trigger user message (${trigger.content.length} chars)...`);

    const natural = await replayChat({
      serviceKey,
      conversationId,
      userId: testUserId,
      message: trigger.content,
      requestId: `${requestId}-natural`,
    });

    const prodChatUsage =
      (transcript.usageAuditNearBroken ?? []).find(
        (u) =>
          u.model === "anthropic/claude-sonnet-4-5" &&
          u.generation_status === "success" &&
          u.finish_reason === "stop"
      ) ?? null;

    const forced = await replayChat({
      serviceKey,
      conversationId,
      userId: testUserId,
      message: trigger.content,
      requestId: `${requestId}-claude`,
      modelOverride: prodChatUsage?.model ?? "anthropic/claude-sonnet-4-5",
    });

    const prodBroken = transcript.brokenAssistant;
    const analyze = (label, result) => {
      const trace = result.trace ?? [];
      const providerEqHttp =
        trace.find((s) => s.stage === "provider_raw_text")?.contentHash ===
        trace.find((s) => s.stage === "before_http_response")?.contentHash;
      return {
        label,
        httpStatus: result.httpStatus,
        model: result.model,
        finishReason: result.finishReason,
        generationStatus: result.generationStatus,
        autoContinueUsed: result.autoContinueUsed,
        finalizeUsed: result.finalizeUsed,
        contentLength: result.content?.length ?? 0,
        contentHash: hashContent(result.content ?? ""),
        tail: tailContent(result.content ?? ""),
        brokenContact: isBrokenContact(result.content ?? ""),
        matchesProdBrokenTail: tailContent(result.content) === tailContent(prodBroken.contentTail) ||
          (prodBroken.contentTail && tailContent(result.content).includes(
            prodBroken.contentTail.slice(-40)
          )),
        providerRawEqualsHttp: providerEqHttp ?? null,
        firstChangedStage: firstChangedStage(trace),
        stageTable: stageTable(trace),
        trace,
      };
    };

    const report = {
      at: new Date().toISOString(),
      stagingUrl: STAGING_URL,
      transcriptPath,
      prodSource: transcript.source,
      prodBrokenAssistant: {
        id: prodBroken.id,
        contentLength: prodBroken.contentLength,
        contentHash: prodBroken.contentHash ?? hashContent(prodBroken.content ?? ""),
        tail: prodBroken.contentTail,
      },
      prodBrokenTailForCompare: prodBroken.contentTail,
      prodUsageAudit: transcript.usageAuditNearBroken ?? [],
      replayNaturalRoute: analyze("natural_route", natural),
      replayForcedProdModel: analyze("forced_prod_model", forced),
      prodChatUsageMatched: prodChatUsage,
      truncationReproduced:
        isBrokenContact(natural.content) ||
        (forced.model === "anthropic/claude-sonnet-4-5" && isBrokenContact(forced.content)),
      conclusion: null,
    };

    if (report.truncationReproduced) {
      const r = report.replayForcedProdModel.brokenContact
        ? report.replayForcedProdModel
        : report.replayNaturalRoute;
      report.conclusion = r.providerRawEqualsHttp
        ? "Truncation reproduced; provider_raw == before_http — source is provider/model output as delivered."
        : `Truncation reproduced; firstChangedStage=${JSON.stringify(r.firstChangedStage)} — source is backend pipeline.`;
    } else {
      report.conclusion =
        "Truncation not reproduced on exact transcript replay. Likely rare provider variance or conditions not fully replicated (memory, summary, tier, timing).";
    }

    writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), "utf8");
    console.log(`\nWrote ${OUT_PATH}`);
    console.log(`Truncation reproduced: ${report.truncationReproduced}`);
    console.log(`Natural: model=${natural.model} broken=${report.replayNaturalRoute.brokenContact}`);
    console.log(`Forced: model=${forced.model} broken=${report.replayForcedProdModel.brokenContact}`);
  } finally {
    if (conversationId) {
      try {
        await deleteTestConversation(STAGING_URL, headers, conversationId);
        console.log(`[cleanup] deleted ${conversationId}`);
      } catch (e) {
        console.error(`[cleanup] failed: ${e.message}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
