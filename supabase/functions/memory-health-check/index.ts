/**
 * Hourly health check for the Memory V3 pipelines (see _shared/memoryV3/healthCheck.ts
 * for the rules). A scheduler (.github/workflows/memory-health.yml) POSTs here with
 * header X-Health-Secret matching MEMORY_HEALTH_SECRET.
 *
 * Body (all optional): {"dryRun": true} reports without alerting;
 * {"test": true} sends one connectivity-test message to Telegram.
 *
 * Any failure answers non-2xx, so a broken check fails the scheduled job loudly
 * instead of looking healthy.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  authorizeMemoryV3HealthRequest,
  runMemoryV3HealthCheck,
  sendMemoryV3HealthTelegram,
} from "../_shared/memoryV3/healthCheck.ts";

const HEALTH_WINDOW_MINUTES = 120;

function respond(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return respond(405, { error: "method_not_allowed" });

  const authorization = authorizeMemoryV3HealthRequest(
    req.headers.get("X-Health-Secret"),
    Deno.env.get("MEMORY_HEALTH_SECRET"),
  );
  if (authorization === "not_configured") return respond(503, { error: "not_configured" });
  if (authorization !== "ok") return respond(401, { error: "unauthorized" });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return respond(500, { error: "misconfigured" });

  let body: { dryRun?: unknown; test?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // No body (or not JSON) means a normal run.
  }

  const svc = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const result = await runMemoryV3HealthCheck({
      dryRun: body?.dryRun === true,
      test: body?.test === true,
      loadSnapshot: async () => {
        const { data, error } = await svc.rpc("memory_v3_health_snapshot", {
          p_window_minutes: HEALTH_WINDOW_MINUTES,
        });
        if (error) throw new Error("snapshot query failed");
        return data;
      },
      reserveAlertKey: async (key) => {
        const { data, error } = await svc.rpc("reserve_memory_v3_alert_window", {
          p_alert_key: key,
        });
        if (error) throw new Error("alert reservation failed");
        return data === true;
      },
      sendTelegram: (text) =>
        sendMemoryV3HealthTelegram({
          botToken: Deno.env.get("STAYSEE_MEMORY_V3_ALERT_TELEGRAM_BOT_TOKEN"),
          chatId: Deno.env.get("STAYSEE_MEMORY_V3_ALERT_TELEGRAM_CHAT_ID"),
          text,
          fetchImpl: globalThis.fetch.bind(globalThis),
        }),
      now: () => new Date(),
    });
    return respond(200, { ok: true, ...result });
  } catch (error) {
    // Only our own fixed messages reach the log: never request data or tokens.
    console.error("[memory-health-check]", error instanceof Error ? error.message : "unknown");
    return respond(500, { ok: false, error: "check_failed" });
  }
});
