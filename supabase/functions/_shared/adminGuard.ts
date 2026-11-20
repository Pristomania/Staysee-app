/**
 * Who may call admin-api and what a request may ask for. Pure logic: no Supabase, no Deno, so it is tested under Node.
 * Design: docs/superpowers/specs/2026-11-20-admin-panel-design.md.
 *
 * The token itself is verified by Auth before any of this runs; here the claims are only READ (the subject, and WHEN the password
 * was last entered: GoTrue puts the sign-in methods with their times into the token as `amr`).
 *
 * Order of refusals: not signed in -> 401 invalid_token; signed in but not an admin -> 403 not_admin (always, so the panel does not
 * reveal itself and a stale password is never mentioned to a person); an admin whose password entry is too old -> 401 password_stale.
 */

/** Access lives this long from the moment the password was entered (absolute, not "since the last click"). */
export const ADMIN_PASSWORD_MAX_AGE_SEC = 30 * 60;

export interface AdminAuthMethod {
  method?: string;
  timestamp?: number;
}

export interface AdminClaims {
  sub?: string;
  amr?: AdminAuthMethod[];
}

export type AdminDenial = "invalid_token" | "not_admin" | "password_stale";

export type AdminAccessDecision =
  | { ok: true; adminId: string }
  | { ok: false; status: 401 | 403; reason: AdminDenial };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The payload of a token, read without checking the signature (Auth has checked it). Null for anything that is not a token. */
export function decodeJwtClaims(token: string): AdminClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payloadPart = parts[1] ?? "";
  if (payloadPart === "" || /[^A-Za-z0-9_-]/.test(payloadPart)) return null;
  try {
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(payload)) return null;
    const amrRaw = payload.amr;
    const amr: AdminAuthMethod[] = Array.isArray(amrRaw)
      ? amrRaw.filter(isRecord).map((entry) => ({
        method: typeof entry.method === "string" ? entry.method : undefined,
        timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined,
      }))
      : [];
    return { sub: typeof payload.sub === "string" ? payload.sub : undefined, amr };
  } catch {
    return null;
  }
}

/** Seconds since the newest password entry in the token; null when the token has none. A time in the future counts as 0. */
export function passwordAgeSeconds(claims: AdminClaims, nowSec: number): number | null {
  let newest: number | null = null;
  for (const entry of claims.amr ?? []) {
    if (entry.method === "password" && typeof entry.timestamp === "number") {
      if (newest === null || entry.timestamp > newest) newest = entry.timestamp;
    }
  }
  return newest === null ? null : Math.max(0, nowSec - newest);
}

export function decideAdminAccess(input: {
  claims: AdminClaims | null;
  isAdmin: boolean;
  nowSec: number;
  maxAgeSec?: number;
}): AdminAccessDecision {
  const { claims, isAdmin, nowSec } = input;
  if (!claims || !claims.sub) return { ok: false, status: 401, reason: "invalid_token" };
  if (!isAdmin) return { ok: false, status: 403, reason: "not_admin" };
  const age = passwordAgeSeconds(claims, nowSec);
  const limit = input.maxAgeSec ?? ADMIN_PASSWORD_MAX_AGE_SEC;
  if (age === null || age > limit) return { ok: false, status: 401, reason: "password_stale" };
  return { ok: true, adminId: claims.sub };
}

// ── The request ──────────────────────────────────────────────────────────────────────────────────────────

export type AdminAction = "overview" | "people" | "person" | "costs" | "feedback" | "errors" | "labels" | "set_label";

const ACTIONS: readonly AdminAction[] = ["overview", "people", "person", "costs", "feedback", "errors", "labels", "set_label"];

export type AdminRequestResult =
  | { ok: true; action: AdminAction; params: Record<string, unknown> }
  | { ok: false; reason: "bad_request" };

const BAD: AdminRequestResult = { ok: false, reason: "bad_request" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL_RE = /^[a-z_]{1,32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function intIn(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function isoOr(value: unknown, fallback: string): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !ISO_RE.test(value) || Number.isNaN(Date.parse(value))) return null;
  return value;
}

/** Checks a request and keeps ONLY the parameters its action knows; anything else in the body is dropped. */
export function parseAdminRequest(body: unknown, nowMs: number = Date.now()): AdminRequestResult {
  if (!isRecord(body) || typeof body.action !== "string") return BAD;
  const action = body.action as AdminAction;
  if (!ACTIONS.includes(action)) return BAD;
  if (body.params !== undefined && !isRecord(body.params)) return BAD;
  const raw: Record<string, unknown> = isRecord(body.params) ? body.params : {};

  switch (action) {
    case "labels":
    case "overview":
      return { ok: true, action, params: {} };

    case "people": {
      const limit = intIn(raw.limit, 50, 1, 100);
      const offset = intIn(raw.offset, 0, 0, 100_000);
      if (limit === null || offset === null) return BAD;
      const params: Record<string, unknown> = {};
      if (raw.search !== undefined) {
        if (typeof raw.search !== "string" || raw.search.length > 100) return BAD;
        if (raw.search !== "") params.search = raw.search;
      }
      if (raw.label !== undefined) {
        if (typeof raw.label !== "string" || !LABEL_RE.test(raw.label)) return BAD;
        params.label = raw.label;
      }
      params.limit = limit;
      params.offset = offset;
      return { ok: true, action, params };
    }

    case "person": {
      if (typeof raw.user_id !== "string" || !UUID_RE.test(raw.user_id)) return BAD;
      return { ok: true, action, params: { user_id: raw.user_id } };
    }

    case "set_label": {
      if (typeof raw.user_id !== "string" || !UUID_RE.test(raw.user_id)) return BAD;
      if (typeof raw.label_key !== "string" || !LABEL_RE.test(raw.label_key)) return BAD;
      return { ok: true, action, params: { user_id: raw.user_id, label_key: raw.label_key } };
    }

    case "costs": {
      const since = isoOr(raw.since, new Date(nowMs - 30 * DAY_MS).toISOString());
      const until = isoOr(raw.until, new Date(nowMs + DAY_MS).toISOString());
      if (since === null || until === null) return BAD;
      return { ok: true, action, params: { since, until } };
    }

    case "feedback": {
      if (raw.kind !== "answers" && raw.kind !== "dynamics") return BAD;
      const limit = intIn(raw.limit, 50, 1, 100);
      const offset = intIn(raw.offset, 0, 0, 100_000);
      if (limit === null || offset === null) return BAD;
      const params: Record<string, unknown> = { kind: raw.kind };
      if (raw.rating !== undefined && raw.rating !== null) {
        if (raw.rating !== 1 && raw.rating !== -1) return BAD;
        params.rating = raw.rating;
      }
      params.limit = limit;
      params.offset = offset;
      return { ok: true, action, params };
    }

    case "errors": {
      const since = isoOr(raw.since, new Date(nowMs - 7 * DAY_MS).toISOString());
      const limit = intIn(raw.limit, 100, 1, 500);
      if (since === null || limit === null) return BAD;
      return { ok: true, action, params: { since, limit } };
    }
  }
}

/** The SQL function (and its arguments) behind an action. `set_label` takes the admin from the verified token, never from the request. */
export function adminRpcCall(
  action: AdminAction,
  params: Record<string, unknown>,
  adminId: string,
): { name: string; args: Record<string, unknown> } {
  switch (action) {
    case "labels":
      return { name: "admin_list_labels", args: {} };
    case "overview":
      return { name: "admin_overview", args: {} };
    case "people":
      return {
        name: "admin_people",
        args: { p_search: params.search ?? null, p_label: params.label ?? null, p_limit: params.limit ?? 50, p_offset: params.offset ?? 0 },
      };
    case "person":
      return { name: "admin_person_card", args: { p_user_id: params.user_id } };
    case "costs":
      return { name: "admin_costs", args: { p_since: params.since, p_until: params.until } };
    case "feedback":
      return {
        name: "admin_feedback",
        args: { p_kind: params.kind, p_rating: params.rating ?? null, p_limit: params.limit ?? 50, p_offset: params.offset ?? 0 },
      };
    case "errors":
      return { name: "admin_errors", args: { p_since: params.since, p_limit: params.limit ?? 100 } };
    case "set_label":
      return { name: "admin_set_label", args: { p_admin_id: adminId, p_user_id: params.user_id, p_label_key: params.label_key } };
  }
}
