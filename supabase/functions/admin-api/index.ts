/**
 * admin-api: the only door of the admin panel (design: docs/superpowers/specs/2026-11-20-admin-panel-design.md).
 *
 *   POST { action, params }  ->  200 { ok: true, data }   |   { error: reason } with 400 / 401 / 403 / 405 / 500 / 503
 *
 * Order, and why: (1) the request is parsed and checked (a malformed body costs nothing); (2) Auth says whose token it is;
 * (3) the admin flag is read from the database with the service key; (4) the decision (admin? password entered within 30 minutes?)
 * is made by adminGuard.ts; (5) only then the matching admin_* SQL function is called. Nothing here reads a table directly, and the
 * admin id handed to the database is the one of the verified token, never a value from the request.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { adminRpcCall, decideAdminAccess, decodeJwtClaims, parseAdminRequest } from "../_shared/adminGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function respond(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Errors the SQL functions raise on purpose (their messages are plain codes, not data). */
const KNOWN_DATABASE_REFUSALS = ["unknown_label", "unknown_user", "not_admin", "bad_kind"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return respond(405, { error: "method_not_allowed" });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return respond(400, { error: "bad_request" });
  }
  const parsed = parseAdminRequest(body);
  if (!parsed.ok) {
    return respond(400, { error: "bad_request" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return respond(503, { error: "service_unavailable" });
  }

  const match = /^Bearer\s+(.+)$/i.exec((req.headers.get("Authorization") ?? "").trim());
  const token = match?.[1]?.trim() ?? "";
  if (!token) {
    return respond(401, { error: "invalid_token" });
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: verified, error: verifyError } = await authClient.auth.getUser(token);
  if (verifyError || !verified?.user) {
    return respond(401, { error: "invalid_token" });
  }

  const claims = decodeJwtClaims(token);
  if (claims?.sub !== verified.user.id) {
    return respond(401, { error: "invalid_token" });
  }

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const adminFlag = await service.rpc("admin_is_admin", { p_user_id: verified.user.id });
  if (adminFlag.error) {
    console.error("[admin-api] admin flag unavailable");
    return respond(500, { error: "admin_call_failed" });
  }

  const decision = decideAdminAccess({
    claims,
    isAdmin: adminFlag.data === true,
    nowSec: Math.floor(Date.now() / 1000),
  });
  if (!decision.ok) {
    return respond(decision.status, { error: decision.reason });
  }

  const call = adminRpcCall(parsed.action, parsed.params, decision.adminId);
  const result = await service.rpc(call.name, call.args);
  if (result.error) {
    const refusal = KNOWN_DATABASE_REFUSALS.find((code) => result.error.message.includes(code));
    if (refusal) {
      return respond(400, { error: refusal });
    }
    console.error(`[admin-api] ${call.name} failed:`, result.error.code ?? "unknown");
    return respond(500, { error: "admin_call_failed" });
  }

  return respond(200, { ok: true, data: result.data });
});
