/**
 * Staging-only atomic quota concurrency/accounting smoke.
 *
 * Dry-run (no network, no credentials):
 *   ./node_modules/.bin/tsx.cmd scripts/atomic-quota-staging-smoke.mts --dry-run
 *
 * Real run requires ALL of:
 *   --run
 *   ATOMIC_QUOTA_SMOKE_RUN=1
 *   STAGING_SUPABASE_URL matching staging project ref only
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY
 *
 * Never calls staysee-chat or any AI provider endpoint.
 * Prints only booleans, counts/deltas, and safe deny reasons.
 * Never uses process.exit; failures set process.exitCode = 1.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const STAGING_PROJECT_REF = "hdmoetcvlszrdukqpiia";
const STAGING_URL_EXACT = `https://${STAGING_PROJECT_REF}.supabase.co`;

class SmokeFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SmokeFailure";
    this.code = code;
  }
}

type ReservePayload = {
  allowed?: unknown;
  tier?: unknown;
  reason?: unknown;
};

type TierRow = {
  daily_request_limit: number;
  daily_requests_used: number;
  day_reset_at: string;
  monthly_tokens_used: number;
  month_reset_at: string;
  is_suspended: boolean;
};

function fail(code: string): never {
  throw new SmokeFailure(code);
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function assertStagingUrl(url: string): void {
  if (url !== STAGING_URL_EXACT) {
    fail("staging_url_mismatch");
  }
  if (!url.includes(STAGING_PROJECT_REF)) {
    fail("staging_ref_missing");
  }
}

function canRunReal(): { ok: true; url: string; key: string } | { ok: false; reason: string } {
  if (!hasFlag("--run")) return { ok: false, reason: "missing_run_flag" };
  if (process.env.ATOMIC_QUOTA_SMOKE_RUN !== "1") {
    return { ok: false, reason: "missing_run_env" };
  }
  const url = process.env.STAGING_SUPABASE_URL ?? "";
  const key = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url) return { ok: false, reason: "missing_staging_url" };
  if (!key) return { ok: false, reason: "missing_staging_service_role_key" };
  if (url !== STAGING_URL_EXACT) return { ok: false, reason: "staging_url_mismatch" };
  return { ok: true, url, key };
}

function asReserve(data: unknown): ReservePayload {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return data as ReservePayload;
}

async function fetchTier(
  sb: SupabaseClient,
  userId: string,
): Promise<TierRow | null> {
  const { data, error } = await sb
    .from("user_usage_tiers")
    .select(
      "daily_request_limit, daily_requests_used, day_reset_at, monthly_tokens_used, month_reset_at, is_suspended",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (error) fail("tier_select_error");
  return (data as TierRow | null) ?? null;
}

async function upsertTier(
  sb: SupabaseClient,
  userId: string,
  patch: Partial<TierRow> & { user_id: string },
): Promise<void> {
  const { error } = await sb.from("user_usage_tiers").upsert(patch, {
    onConflict: "user_id",
  });
  if (error) fail("tier_upsert_error");
}

async function reserveOnce(
  sb: SupabaseClient,
  userId: string,
): Promise<{ payload: ReservePayload; error: boolean }> {
  const { data, error } = await sb.rpc("reserve_ai_request", {
    p_user_id: userId,
  });
  return { payload: asReserve(data), error: !!error };
}

/** Cleanup must never throw SmokeFailure / call fail. */
async function attemptCleanup(
  sb: SupabaseClient,
  tempUserId: string | null,
): Promise<boolean> {
  if (!tempUserId) return true;
  try {
    const del = await sb.auth.admin.deleteUser(tempUserId);
    if (del.error) return false;
    const { data, error } = await sb
      .from("user_usage_tiers")
      .select("user_id")
      .eq("user_id", tempUserId)
      .maybeSingle();
    if (error) return false;
    return data === null;
  } catch {
    return false;
  }
}

async function runDryRun(): Promise<void> {
  // Local mode only: validate flags/config shape, no network, no credentials.
  if (hasFlag("--run") && process.env.ATOMIC_QUOTA_SMOKE_RUN === "1") {
    fail("dry_run_incompatible_with_real_flags");
  }
  assertStagingUrl(STAGING_URL_EXACT);
  console.log("DRY_RUN_OK=true");
}

async function runReal(): Promise<void> {
  const gate = canRunReal();
  if (gate.ok === false) fail(gate.reason);
  assertStagingUrl(gate.url);

  const sb = createClient(gate.url, gate.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const stamp = Date.now().toString(36);
  const tempEmail = `atomic-quota-smoke-${stamp}@example.invalid`;
  const tempPassword = `Aq-${stamp}-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  let tempUserId: string | null = null;
  let cleanupOk = false;
  let scenarioFailure: SmokeFailure | null = null;

  try {
    const created = await sb.auth.admin.createUser({
      email: tempEmail,
      password: tempPassword,
      email_confirm: true,
    });
    if (created.error || !created.data.user?.id) fail("temp_user_create_failed");
    tempUserId = created.data.user.id;

    // Ensure tier row exists for fixture tests (trigger may already create one).
    const existing = await fetchTier(sb, tempUserId);
    if (!existing) {
      await upsertTier(sb, tempUserId, {
        user_id: tempUserId,
        daily_request_limit: 1,
        daily_requests_used: 0,
        day_reset_at: new Date().toISOString(),
        monthly_tokens_used: 0,
        month_reset_at: new Date().toISOString(),
        is_suspended: false,
      });
    }

    // A. missing row
    {
      const missingId = randomUUID();
      const before = await fetchTier(sb, missingId);
      if (before) fail("missing_row_fixture_collision");
      const { payload, error } = await reserveOnce(sb, missingId);
      const ok =
        !error &&
        payload.allowed === false &&
        payload.reason === "missing_tier";
      console.log(`MISSING_ROW_OK=${ok}`);
      if (!ok) fail("missing_row_case");
    }

    // B. suspended
    {
      const before = await fetchTier(sb, tempUserId);
      if (!before) fail("suspended_missing_tier");
      const usedBefore = before.daily_requests_used;
      await upsertTier(sb, tempUserId, {
        user_id: tempUserId,
        is_suspended: true,
        daily_request_limit: before.daily_request_limit,
        daily_requests_used: usedBefore,
        day_reset_at: before.day_reset_at,
        monthly_tokens_used: before.monthly_tokens_used,
        month_reset_at: before.month_reset_at,
      });
      const { payload, error } = await reserveOnce(sb, tempUserId);
      const after = await fetchTier(sb, tempUserId);
      const ok =
        !error &&
        payload.allowed === false &&
        payload.reason === "suspended" &&
        !!after &&
        after.daily_requests_used === usedBefore;
      console.log(`SUSPENDED_OK=${ok}`);
      if (!ok) fail("suspended_case");
      await upsertTier(sb, tempUserId, {
        user_id: tempUserId,
        is_suspended: false,
        daily_request_limit: 1,
        daily_requests_used: 0,
        day_reset_at: new Date().toISOString(),
        monthly_tokens_used: after?.monthly_tokens_used ?? 0,
        month_reset_at: after?.month_reset_at ?? new Date().toISOString(),
      });
    }

    // C. concurrency remaining=1
    {
      await upsertTier(sb, tempUserId, {
        user_id: tempUserId,
        is_suspended: false,
        daily_request_limit: 1,
        daily_requests_used: 0,
        day_reset_at: new Date().toISOString(),
        monthly_tokens_used: 0,
        month_reset_at: new Date().toISOString(),
      });
      const [a, b] = await Promise.all([
        reserveOnce(sb, tempUserId),
        reserveOnce(sb, tempUserId),
      ]);
      const payloads = [a.payload, b.payload];
      const allowCount = payloads.filter((p) => p.allowed === true).length;
      const denyCount = payloads.filter(
        (p) => p.allowed === false && p.reason === "daily_limit",
      ).length;
      const final = await fetchTier(sb, tempUserId);
      console.log(`CONCURRENCY_ALLOW_COUNT=${allowCount}`);
      console.log(`CONCURRENCY_DENY_COUNT=${denyCount}`);
      console.log(`FINAL_DAILY_USED=${final?.daily_requests_used ?? -1}`);
      if (allowCount !== 1 || denyCount !== 1) fail("concurrency_outcome");
      if (!final || final.daily_requests_used !== 1) fail("concurrency_final_used");
      if (a.error || b.error) fail("concurrency_rpc_error");
    }

    // D. expired day window
    {
      const oldReset = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await upsertTier(sb, tempUserId, {
        user_id: tempUserId,
        is_suspended: false,
        daily_request_limit: 1,
        daily_requests_used: 1,
        day_reset_at: oldReset,
        monthly_tokens_used: 0,
        month_reset_at: new Date().toISOString(),
      });
      const before = await fetchTier(sb, tempUserId);
      const { payload, error } = await reserveOnce(sb, tempUserId);
      const after = await fetchTier(sb, tempUserId);
      const resetUpdated =
        !!before &&
        !!after &&
        new Date(after.day_reset_at).getTime() > new Date(before.day_reset_at).getTime();
      const ok =
        !error &&
        payload.allowed === true &&
        !!after &&
        after.daily_requests_used === 1 &&
        resetUpdated;
      console.log(`DAY_RESET_OK=${ok}`);
      if (!ok) fail("day_reset_case");
    }

    // E. monthly tokens only
    {
      const dayReset = new Date().toISOString();
      await upsertTier(sb, tempUserId, {
        user_id: tempUserId,
        is_suspended: false,
        daily_request_limit: 5,
        daily_requests_used: 2,
        day_reset_at: dayReset,
        monthly_tokens_used: 10,
        month_reset_at: new Date().toISOString(),
      });
      const before = await fetchTier(sb, tempUserId);
      if (!before) fail("token_before_missing");
      const { error } = await sb.rpc("add_ai_token_usage", {
        p_user_id: tempUserId,
        p_tokens: 7,
      });
      const after = await fetchTier(sb, tempUserId);
      const ok =
        !error &&
        !!after &&
        after.monthly_tokens_used === 17 &&
        after.daily_requests_used === before.daily_requests_used &&
        after.day_reset_at === before.day_reset_at &&
        after.daily_request_limit === before.daily_request_limit;
      console.log(`TOKEN_ACCOUNTING_OK=${ok}`);
      if (!ok) fail("token_accounting_case");
    }

    // F. invalid tokens
    {
      const before = await fetchTier(sb, tempUserId);
      if (!before) fail("invalid_token_before_missing");
      const { error } = await sb.rpc("add_ai_token_usage", {
        p_user_id: tempUserId,
        p_tokens: -1,
      });
      const after = await fetchTier(sb, tempUserId);
      const ok =
        !!error &&
        !!after &&
        after.monthly_tokens_used === before.monthly_tokens_used &&
        after.daily_requests_used === before.daily_requests_used &&
        after.day_reset_at === before.day_reset_at;
      console.log(`INVALID_TOKEN_REJECTED=${ok}`);
      if (!ok) fail("invalid_token_case");
    }
  } catch (err) {
    if (err instanceof SmokeFailure) {
      scenarioFailure = err;
    } else {
      scenarioFailure = new SmokeFailure("unhandled_exception");
    }
  } finally {
    cleanupOk = await attemptCleanup(sb, tempUserId);
    console.log(`CLEANUP_OK=${cleanupOk}`);
  }

  // Cleanup failure wins over scenario failure; never print secrets/IDs.
  if (!cleanupOk) {
    console.error("SMOKE_FAIL=cleanup_failed");
    process.exitCode = 1;
    return;
  }

  if (scenarioFailure) {
    console.error(`SMOKE_FAIL=${scenarioFailure.code}`);
    process.exitCode = 1;
    return;
  }

  // Only after A–F success + successful cleanup + confirmed no leftover tier row.
  console.log("SMOKE_OK=true");
}

async function main(): Promise<void> {
  if (hasFlag("--dry-run")) {
    await runDryRun();
    return;
  }

  // Without --dry-run, demand the full real-mode gate (no accidental network).
  const gate = canRunReal();
  if (gate.ok === false) fail(gate.reason);
  await runReal();
}

main().catch((err: unknown) => {
  const code = err instanceof SmokeFailure ? err.code : "unhandled_exception";
  console.error(`SMOKE_FAIL=${code}`);
  process.exitCode = 1;
});
