/**
 * Static architecture contract for migration 031 atomic chat quota SQL.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/atomicQuotaMigration.cases.test.ts
 *
 * This is not a live concurrency proof — only a source contract over the migration text.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Extract one CREATE FUNCTION ... $$ ... $$; block by function name. */
function extractFunctionSql(sql: string, fnName: string): string {
  const re = new RegExp(
    String.raw`CREATE OR REPLACE FUNCTION public\.${fnName}\s*\([\s\S]*?\$\$;`,
    "i",
  );
  const match = sql.match(re)?.[0] ?? "";
  assert(match.length > 0, `function ${fnName} block must be extractable`);
  return match;
}

/** Body between the first AS $$ and the closing $$; of that function block. */
function extractFunctionBody(fnSql: string): string {
  const start = fnSql.search(/AS\s*\$\$/i);
  assert(start >= 0, `AS $$ marker required in function block`);
  const marker = fnSql.slice(start).match(/AS\s*\$\$/i)![0];
  const after = fnSql.slice(start + marker.length);
  const end = after.lastIndexOf("$$");
  assert(end >= 0, "closing $$ required");
  return after.slice(0, end);
}

const migrationPath = resolve(
  "supabase/migrations/20260730120000_031_atomic_chat_quota.sql",
);

assert(existsSync(migrationPath), "migration 031 must exist");

const sql = readFileSync(migrationPath, "utf8");

const reserveSql = extractFunctionSql(sql, "reserve_ai_request");
const tokenSql = extractFunctionSql(sql, "add_ai_token_usage");
const reserveBody = extractFunctionBody(reserveSql);
const tokenBody = extractFunctionBody(tokenSql);

// ── Per-function CREATE / security / search_path ─────────────────────────────

assert(
  /CREATE OR REPLACE FUNCTION public\.reserve_ai_request/i.test(reserveSql),
  "reserve CREATE OR REPLACE FUNCTION public.*",
);
assert(/SECURITY DEFINER/i.test(reserveSql), "reserve SECURITY DEFINER");
assert(/SET search_path\s*=\s*''/i.test(reserveSql), "reserve empty search_path");
assert(
  !/SET search_path\s*=\s*public/i.test(reserveSql),
  "reserve must not use search_path public",
);

assert(
  /CREATE OR REPLACE FUNCTION public\.add_ai_token_usage/i.test(tokenSql),
  "token CREATE OR REPLACE FUNCTION public.*",
);
assert(/SECURITY DEFINER/i.test(tokenSql), "token SECURITY DEFINER");
assert(/SET search_path\s*=\s*''/i.test(tokenSql), "token empty search_path");
assert(
  !/SET search_path\s*=\s*public/i.test(tokenSql),
  "token must not use search_path public",
);

// ── reserve_ai_request body contracts ────────────────────────────────────────

assert(
  /reserve_ai_request\s*\(\s*p_user_id\s+uuid\s*\)/i.test(reserveSql),
  "reserve signature p_user_id uuid",
);
assert(
  /FROM public\.user_usage_tiers/i.test(reserveBody),
  "reserve schema-qualified user_usage_tiers",
);
assert(/FOR UPDATE/i.test(reserveBody), "reserve SELECT ... FOR UPDATE");
assert(
  /missing_tier/i.test(reserveBody),
  "reserve missing row → missing_tier",
);
assert(/suspended/i.test(reserveBody), "reserve suspended → suspended");
assert(
  /interval\s+'24 hours'/i.test(reserveBody),
  "reserve 24 hours day reset",
);
assert(/daily_limit/i.test(reserveBody), "reserve daily_limit deny");
assert(
  /daily_requests_used/i.test(reserveBody),
  "reserve body owns daily_requests_used",
);
assert(
  /daily_requests_used\s*=\s*daily_requests_used\s*\+\s*1/i.test(reserveBody),
  "daily_requests_used increments only in reserve body",
);

// ── add_ai_token_usage body contracts ────────────────────────────────────────

assert(
  /add_ai_token_usage\s*\(\s*p_user_id\s+uuid\s*,\s*p_tokens\s+integer\s*\)/i.test(
    tokenSql,
  ),
  "token signature p_user_id uuid, p_tokens integer",
);
assert(
  /UPDATE public\.user_usage_tiers/i.test(tokenBody),
  "token schema-qualified user_usage_tiers",
);
assert(
  /p_tokens\s+IS NULL\s+OR\s+p_tokens\s*<\s*0/i.test(tokenBody),
  "token null/negative guard",
);

const tokenGuardRe = /IF\s+p_tokens\s+IS NULL\s+OR\s+p_tokens\s*<\s*0/i;
const tokenUpdateRe = /UPDATE\s+public\.user_usage_tiers/i;
const tokenGuardMatch = tokenBody.match(tokenGuardRe);
const tokenUpdateMatch = tokenBody.match(tokenUpdateRe);
assert(tokenGuardMatch !== null && tokenGuardMatch.index !== undefined, "token validation IF must exist");
assert(tokenUpdateMatch !== null && tokenUpdateMatch.index !== undefined, "token UPDATE must exist");
assert(
  tokenGuardMatch.index < tokenUpdateMatch.index,
  "validation guard must appear before UPDATE",
);
assert(
  !/WHERE[\s\S]*p_tokens\s+IS\s+NOT\s+NULL/i.test(tokenBody),
  "UPDATE must not mask validation with p_tokens IS NOT NULL",
);
assert(
  !/WHERE[\s\S]*p_tokens\s*>=\s*0/i.test(tokenBody),
  "UPDATE must not mask validation with p_tokens >= 0",
);

assert(
  /interval\s+'30 days'/i.test(tokenBody),
  "token 30 days month reset",
);
assert(
  /monthly_tokens_used/i.test(tokenBody),
  "token updates monthly_tokens_used",
);
assert(
  !/daily_requests_used/i.test(tokenBody),
  "token body must not contain daily_requests_used",
);
assert(
  !/monthly_token_limit/i.test(tokenBody),
  "token body must not contain monthly_token_limit",
);
assert(
  !/monthly_tokens_used\s*[><]=?/i.test(tokenBody),
  "token body must not compare monthly_tokens_used against a limit",
);
assert(
  !/monthly_limit/i.test(tokenBody),
  "token body must not use reason monthly_limit",
);

// ── Grants (file-level, both RPCs) ───────────────────────────────────────────

assert(
  /REVOKE ALL ON FUNCTION public\.reserve_ai_request\(uuid\) FROM PUBLIC/i.test(
    sql,
  ),
  "revoke PUBLIC reserve",
);
assert(
  /REVOKE ALL ON FUNCTION public\.reserve_ai_request\(uuid\) FROM anon/i.test(
    sql,
  ),
  "revoke anon reserve",
);
assert(
  /REVOKE ALL ON FUNCTION public\.reserve_ai_request\(uuid\) FROM authenticated/i.test(
    sql,
  ),
  "revoke authenticated reserve",
);
assert(
  /GRANT EXECUTE ON FUNCTION public\.reserve_ai_request\(uuid\) TO service_role/i.test(
    sql,
  ),
  "grant reserve service_role",
);

assert(
  /REVOKE ALL ON FUNCTION public\.add_ai_token_usage\(uuid,\s*integer\) FROM PUBLIC/i.test(
    sql,
  ),
  "revoke PUBLIC tokens",
);
assert(
  /REVOKE ALL ON FUNCTION public\.add_ai_token_usage\(uuid,\s*integer\) FROM anon/i.test(
    sql,
  ),
  "revoke anon tokens",
);
assert(
  /REVOKE ALL ON FUNCTION public\.add_ai_token_usage\(uuid,\s*integer\) FROM authenticated/i.test(
    sql,
  ),
  "revoke authenticated tokens",
);
assert(
  /GRANT EXECUTE ON FUNCTION public\.add_ai_token_usage\(uuid,\s*integer\) TO service_role/i.test(
    sql,
  ),
  "grant tokens service_role",
);

// ── Legacy increment_usage untouched ─────────────────────────────────────────

assert(
  !/DROP\s+FUNCTION\s+.*increment_usage/i.test(sql),
  "must not DROP increment_usage",
);
assert(
  !/CREATE OR REPLACE FUNCTION public\.increment_usage/i.test(sql),
  "031 must not rewrite increment_usage",
);

console.log("=== atomicQuotaMigration.cases.test.ts OK ===");
