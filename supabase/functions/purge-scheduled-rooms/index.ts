/**
 * Daily cron: delete auth users whose room_purge_after <= now().
 * POST with header X-Purge-Secret matching PURGE_ROOMS_SECRET (or CRON_SECRET).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Purge-Secret, Apikey",
};

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

  const expected = Deno.env.get("PURGE_ROOMS_SECRET")?.trim()
    ?? Deno.env.get("CRON_SECRET")?.trim();
  const provided = req.headers.get("X-Purge-Secret")?.trim();
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) {
    return new Response(JSON.stringify({ error: "misconfigured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: ids, error } = await admin.rpc("list_rooms_ready_for_purge", {
    p_limit: 50,
  });
  if (error) {
    console.error("[purge-scheduled-rooms]", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userIds = (ids ?? []) as string[];
  const results: { user_id: string; ok: boolean; detail?: string }[] = [];

  for (const userId of userIds) {
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    results.push({
      user_id: userId,
      ok: !delErr,
      detail: delErr?.message,
    });
  }

  const purgedCount = results.filter((r) => r.ok).length;

  return new Response(
    JSON.stringify({ ok: true, processed: results.length, purged: purgedCount, results }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
