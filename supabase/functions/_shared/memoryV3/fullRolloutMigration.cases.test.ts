import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIGRATION_URL = new URL(
  "../../../migrations/20260922120000_038_memory_v3_full_rollout_alerts.sql",
  import.meta.url,
);
const PGTAP_URL = new URL(
  "../../../tests/database/038_memory_v3_full_rollout_alerts.test.sql",
  import.meta.url,
);

const ALERT_KEYS = [
  "read:load_failed",
  "read:invalid_shape",
  "read:too_large",
  "write:invalid_source",
  "write:state_too_large",
  "write:extractor_transport_failed",
  "write:extractor_parse_invalid",
  "write:extractor_shape_invalid",
  "write:extractor_contract_invalid",
  "write:reconciler_request_too_large",
  "write:reconciler_transport_failed",
  "write:reconciler_parse_invalid",
  "write:reconciler_shape_invalid",
  "write:reconciler_contract_invalid",
  "write:state_conflict",
  "write:state_write_failed",
  "write:reservation_failed",
  "write:unknown_failure",
] as const;

function migrationSql(): string {
  assert.equal(existsSync(MIGRATION_URL), true, "migration 038 must exist");
  return readFileSync(MIGRATION_URL, "utf8");
}

function pgTapSql(): string {
  assert.equal(existsSync(PGTAP_URL), true, "migration 038 pgTAP test must exist");
  return readFileSync(PGTAP_URL, "utf8");
}

function functionBlock(sql: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${escaped}\\([\\s\\S]*?\\$function\\$;`,
    "iu",
  ));
  assert.ok(match, `${name} function block must be extractable`);
  return match[0];
}

describe("Memory V3 full rollout migration", () => {
  it("restores the lifecycle daily cap to one without changing the RPC signature", () => {
    const sql = migrationSql();
    const body = functionBlock(sql, "reserve_memory_v3_lifecycle_shadow_run");
    assert.match(
      body,
      /reserve_memory_v3_lifecycle_shadow_run\(\s*p_user_id uuid,\s*p_conversation_id uuid,\s*p_pipeline_version text,\s*p_extractor_version text,\s*p_reconciler_version text,\s*p_model text,\s*p_input_hash text,\s*p_source_last_message_id uuid,\s*p_source_last_created_at timestamptz,\s*p_message_count integer,\s*p_user_message_count integer\s*\)/iu,
    );
    assert.match(body, /IF v_daily_count >= 1 THEN/iu);
    assert.doesNotMatch(body, /IF v_daily_count >= 5 THEN/iu);
    assert.match(body, /pg_catalog\.pg_advisory_xact_lock/iu);
    assert.match(body, /result := 'duplicate'/iu);
    assert.match(body, /result := 'daily_cap'/iu);
    assert.match(body, /result := 'reserved'/iu);
  });

  it("creates a private hourly alert window table and service-only RPC", () => {
    const sql = migrationSql();
    const body = functionBlock(sql, "reserve_memory_v3_alert_window");
    assert.match(sql, /CREATE TABLE public\.memory_v3_alert_windows\s*\(/iu);
    assert.match(sql, /PRIMARY KEY \(alert_key, window_start\)/iu);
    assert.match(sql, /ALTER TABLE public\.memory_v3_alert_windows ENABLE ROW LEVEL SECURITY/iu);
    assert.doesNotMatch(sql, /CREATE\s+POLICY/iu);
    assert.match(body, /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = ''/iu);
    assert.match(body, /date_trunc\('hour', pg_catalog\.now\(\) AT TIME ZONE 'UTC'\)/iu);
    assert.match(body, /ON CONFLICT \(alert_key, window_start\) DO NOTHING/iu);
    assert.match(body, /14 days/iu);
    assert.match(
      sql,
      /REVOKE ALL ON TABLE public\.memory_v3_alert_windows\s+FROM PUBLIC, anon, authenticated, service_role/iu,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.reserve_memory_v3_alert_window\(text\)\s+TO service_role/iu,
    );
  });

  it("uses an exact closed alert-key allowlist", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_alert_window");
    for (const key of ALERT_KEYS) assert.ok(body.includes(`'${key}'`), key);
    assert.doesNotMatch(body, /LIKE|SIMILAR TO|regexp|~\*/iu);
  });

  it("contains pgTAP coverage for deduplication, rejection, and privileges", () => {
    const sql = pgTapSql();
    assert.match(sql, /SELECT plan\(12\)/iu);
    assert.match(sql, /read:load_failed/iu);
    assert.match(sql, /write:state_write_failed/iu);
    assert.match(sql, /invalid:sentinel/iu);
    assert.match(sql, /has_function_privilege\(\s*'service_role'/iu);
    assert.match(sql, /has_function_privilege\(\s*'authenticated'/iu);
    assert.match(sql, /has_table_privilege\(\s*'service_role'/iu);
    assert.match(sql, /ROLLBACK/iu);
  });

  it("adds no network, provider, user content, or Telegram secret storage", () => {
    const sql = migrationSql();
    const alertBoundary = sql.slice(
      0,
      sql.indexOf("CREATE OR REPLACE FUNCTION public.reserve_memory_v3_lifecycle_shadow_run"),
    );
    assert.ok(alertBoundary.length > 0, "alert boundary must precede lifecycle reservation");
    assert.doesNotMatch(alertBoundary, /https?:\/\/|api\.telegram|authorization|bot_token|chat_id|message_text/iu);
    assert.doesNotMatch(alertBoundary, /conversation_text|dialogue|claim|evidence|prompt|provider_body/iu);
  });
});
