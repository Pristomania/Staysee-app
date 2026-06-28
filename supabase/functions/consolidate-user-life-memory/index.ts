/**
 * POST { dryRun?: boolean, userId?: string }
 * Auth: service role JWT or BACKFILL_SECRET
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { makeServiceClient } from "../_shared/cost.ts";
import { buildOpenRouterUtilityModelConfig } from "../_shared/approvedModels.ts";
import { consolidateAllUserLifeMemory } from "../_shared/consolidateUserLifeMemory.ts";
import {
  emptyStructuredMemory,
  mergeStructuredMemory,
  parseStoredMemory,
} from "../_shared/memory.ts";
import { refreshUserLifeMemory } from "../_shared/userLifeMemory.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Backfill-Secret, Apikey",
};

const MODEL = buildOpenRouterUtilityModelConfig({
  envKey: "STAYSEE_SUMMARY_MODEL",
  title: "StaySee Memory Consolidate",
});

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

function authorized(req: Request): boolean {
  const secret = Deno.env.get("BACKFILL_SECRET");
  const headerSecret = req.headers.get("X-Backfill-Secret");
  if (secret && headerSecret === secret) return true;
  const token = extractAuthToken(req);
  if (token && isServiceRoleJwt(token)) return true;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return !!(token && serviceKey && token === serviceKey);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!authorized(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: {
    dryRun?: boolean;
    userId?: string;
    forceRebuild?: boolean;
    recoverFromSummaries?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "missing OPENROUTER_API_KEY" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = makeServiceClient();
  const modelConfig = { ...MODEL, apiKey };

  if (body.recoverFromSummaries) {
    let q = supabase
      .from("conversations")
      .select("id, user_id, conversation_summary")
      .not("conversation_summary", "is", null);
    if (body.userId) q = q.eq("user_id", body.userId);

    const { data: convs, error: convErr } = await q;
    if (convErr) {
      return new Response(JSON.stringify({ error: convErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const byUser = new Map<string, ReturnType<typeof emptyStructuredMemory>>();
    for (const c of convs ?? []) {
      const uid = c.user_id as string;
      const parsed = parseStoredMemory(c.conversation_summary as string);
      if (!parsed) continue;
      const prev = byUser.get(uid) ?? emptyStructuredMemory();
      byUser.set(uid, mergeStructuredMemory(prev, parsed));
    }

    const recovered: Array<{ userId: string; fields: number }> = [];
    for (const [userId, memory] of byUser) {
      if (body.dryRun) {
        recovered.push({ userId, fields: memory.people.length + memory.themes.length });
        continue;
      }
      await refreshUserLifeMemory(supabase, userId, memory, modelConfig);
      recovered.push({ userId, fields: memory.people.length + memory.themes.length });
    }

    let results: Awaited<ReturnType<typeof consolidateAllUserLifeMemory>> = [];
    try {
      results = await consolidateAllUserLifeMemory(supabase, modelConfig, {
        userId: body.userId,
        dryRun: false,
        forceRebuild: true,
      });
    } catch (e) {
      console.error("[consolidate] post-recover merge failed:", e);
    }

    return new Response(
      JSON.stringify({ recovered, consolidate: results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const results = await consolidateAllUserLifeMemory(
    supabase,
    modelConfig,
    {
      userId: body.userId,
      dryRun: body.dryRun ?? false,
      forceRebuild: body.forceRebuild ?? true,
    }
  );

  const summary = {
    users: results.length,
    removed: results.reduce((s, r) => s + r.removed, 0),
    added: results.reduce((s, r) => s + r.added, 0),
    dryRun: body.dryRun ?? false,
  };

  return new Response(JSON.stringify({ summary, results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
