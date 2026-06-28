import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { checkRateLimit, CALM_ERRORS } from "../_shared/cost.ts";
import { resolveApprovedUtilityModel } from "../_shared/approvedModels.ts";
import { generateWeeklyReflectionText } from "../_shared/weeklyReflection.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const REFLECTION_MODEL = resolveApprovedUtilityModel("STAYSEE_REFLECTION_MODEL").primary;

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

  try {
    const body = await req.json() as { conversationId?: string; userId?: string };
    const conversationId = body.conversationId?.trim();
    const userId = body.userId?.trim();

    if (!conversationId || !userId) {
      return new Response(JSON.stringify({ error: "conversationId and userId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    if (!authToken || !supabaseUrl || !supabaseAnonKey) {
      return new Response(JSON.stringify({ error: "auth_required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userSupabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${authToken}` } },
    });

    const rate = await checkRateLimit(userSupabase, userId);
    if (!rate.allowed) {
      return new Response(
        JSON.stringify({ error: rate.reason ?? "rate_limit", text: null }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: conv, error: convErr } = await userSupabase
      .from("conversations")
      .select("id, title, conversation_summary")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();

    if (convErr || !conv) {
      return new Response(JSON.stringify({ error: "conversation_not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
    const { text, generated } = await generateWeeklyReflectionText(
      userSupabase,
      {
        conversationId,
        conversationTitle: conv.title ?? null,
        conversationSummary: conv.conversation_summary ?? null,
      },
      {
        baseUrl: "https://openrouter.ai/api/v1",
        model: REFLECTION_MODEL,
        apiKey,
        extraHeaders: {
          "HTTP-Referer": "https://staysee.app",
          "X-Title": "StaySee Weekly Reflection",
        },
      },
    );

    return new Response(
      JSON.stringify({ text, generated }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[weekly-reflection]", e);
    return new Response(
      JSON.stringify({ error: "internal", text: CALM_ERRORS.unavailable }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
