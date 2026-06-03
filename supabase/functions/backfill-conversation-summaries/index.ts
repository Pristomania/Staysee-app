/**
 * StaySee — Backfill conversation_summary for existing conversations.
 *
 * Invoke with service role or BACKFILL_SECRET (admin/ops only).
 * POST { batchSize?: number, cursor?: string, dryRun?: boolean }
 *
 * Returns { processed, results, nextCursor, done }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { makeServiceClient } from "../_shared/cost.ts";
import {
  BACKFILL_CONVERSATIONS_PER_RUN,
  backfillOneConversation,
  countConversationMessages,
  fetchConversationById,
  fetchConversationsNeedingBackfill,
  type BackfillResult,
} from "../_shared/backfillMemory.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Backfill-Secret, Apikey",
};

const SUMMARY_MODEL = {
  baseUrl: "https://openrouter.ai/api/v1",
  model: "anthropic/claude-3.5-haiku",
  envKey: "OPENROUTER_API_KEY",
  extraHeaders: {
    "HTTP-Referer": "https://staysee.app",
    "X-Title": "StaySee Backfill",
  },
};

interface RequestBody {
  batchSize?: number;
  /** ISO last_message_at cursor for pagination */
  cursor?: string | null;
  dryRun?: boolean;
  /** Force rebuild for one conversation (ignores skip / empty-summary filters). */
  conversationId?: string;
  force?: boolean;
}

/** Bearer token or apikey (Supabase clients send both). */
function extractAuthToken(req: Request): string | null {
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]) return bearer[1].trim();

  const apikey = req.headers.get("apikey") ?? req.headers.get("Apikey");
  return apikey?.trim() || null;
}

function projectRef(): string | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const match = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return match?.[1] ?? null;
}

/** Accept legacy JWT service_role keys (role + project ref). */
function isServiceRoleJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64)) as { role?: string; ref?: string };
    if (payload.role !== "service_role") return false;
    const ref = projectRef();
    if (ref && payload.ref && payload.ref !== ref) return false;
    return true;
  } catch {
    return false;
  }
}

function authorize(req: Request): boolean {
  const backfillSecret = Deno.env.get("BACKFILL_SECRET")?.trim();
  const headerSecret = req.headers.get("X-Backfill-Secret")?.trim();
  if (backfillSecret && headerSecret && headerSecret === backfillSecret) {
    return true;
  }

  const token = extractAuthToken(req);
  if (!token) return false;

  const serviceKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  if (serviceKey && token === serviceKey) return true;

  if (isServiceRoleJwt(token)) return true;

  return false;
}

/** Prefer caller service-role token so DB writes match authorized key. */
function makeServiceClientForRequest(req: Request) {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const token = extractAuthToken(req);
  const serverKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  if (token && (token === serverKey || isServiceRoleJwt(token))) {
    return createClient(url, token);
  }
  return makeServiceClient();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!authorize(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get(SUMMARY_MODEL.envKey);
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "missing OPENROUTER_API_KEY" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const forcedId = body.conversationId?.trim();

  const batchSize = Math.min(
    Math.max(1, body.batchSize ?? BACKFILL_CONVERSATIONS_PER_RUN),
    20
  );
  const dryRun = body.dryRun === true;
  const cursor = body.cursor ?? null;

  const supabase = makeServiceClientForRequest(req);

  const model = {
    baseUrl: SUMMARY_MODEL.baseUrl,
    model: SUMMARY_MODEL.model,
    apiKey,
    extraHeaders: SUMMARY_MODEL.extraHeaders,
  };

  if (forcedId) {
    const conversation = await fetchConversationById(supabase, forcedId);
    if (!conversation) {
      return new Response(
        JSON.stringify({
          processed: 0,
          forced: true,
          conversationId: forcedId,
          error: "conversation_not_found",
          results: [],
          done: true,
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let result: BackfillResult;
    if (dryRun) {
      const messageCount = await countConversationMessages(supabase, conversation.id);
      result = {
        conversationId: conversation.id,
        status: "skipped",
        messagesFound: messageCount,
        forced: true,
      };
    } else {
      result = await backfillOneConversation(supabase, model, conversation, {
        force: true,
      });
    }

    console.log(
      `[backfill] forced id=${conversation.id} messages=${result.messagesFound ?? result.messageCount} summary=${result.summaryGenerated} saved=${result.saved} status=${result.status}`
    );

    return new Response(
      JSON.stringify({
        processed: 1,
        forced: true,
        conversationId: conversation.id,
        ok: result.status === "ok" ? 1 : 0,
        failed: result.status === "failed" ? 1 : 0,
        skipped: result.status === "skipped" ? 1 : 0,
        dryRun,
        results: [result],
        nextCursor: null,
        done: true,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const conversations = await fetchConversationsNeedingBackfill(
    supabase,
    batchSize,
    cursor
  );

  if (conversations.length === 0) {
    return new Response(
      JSON.stringify({
        processed: 0,
        results: [],
        nextCursor: null,
        done: true,
        message: "no conversations need backfill",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const results: BackfillResult[] = [];

  if (dryRun) {
    for (const c of conversations) {
      results.push({ conversationId: c.id, status: "skipped" });
    }
  } else {
    for (const c of conversations) {
      const result = await backfillOneConversation(supabase, model, c);
      results.push(result);
    }
  }

  const last = conversations[conversations.length - 1];
  const { data: lastRow } = await supabase
    .from("conversations")
    .select("last_message_at")
    .eq("id", last.id)
    .maybeSingle();

  const nextCursor = lastRow?.last_message_at ?? null;
  const moreNeeded = dryRun
    ? conversations.length > 0
    : (await fetchConversationsNeedingBackfill(supabase, 1, nextCursor)).length > 0;
  const done = !moreNeeded;

  const ok = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  console.log(
    `[backfill] batch ok=${ok} failed=${failed} skipped=${skipped} dryRun=${dryRun}`
  );

  return new Response(
    JSON.stringify({
      processed: conversations.length,
      ok,
      failed,
      skipped,
      dryRun,
      results,
      nextCursor,
      done,
      hint: done
        ? "complete"
        : `call again with cursor: ${JSON.stringify(nextCursor)}`,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
