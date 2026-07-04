/**
 * Run: npx tsx scripts/lib/schema-drift.cases.test.ts
 */

import {
  assertReadOnlySql,
  buildAuditSafetyNotes,
  buildKnownMemoryChecks,
  compareColumns,
  compareIndexes,
  compareTables,
  maskSecrets,
  renderMarkdownReport,
  resolveAuditSchemaMode,
  type ColumnMeta,
  type IndexMeta,
  type SchemaDriftReport,
} from "./schema-drift.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertThrows(label: string, fn: () => void): void {
  try {
    fn();
    throw new Error(`Expected throw: ${label}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Expected throw:")) throw e;
  }
}

assertThrows("forbidden ALTER", () => assertReadOnlySql("ALTER TABLE foo ADD COLUMN bar text"));
assertThrows("forbidden DELETE substring safe", () =>
  assertReadOnlySql("DELETE FROM conversations")
);
assertReadOnlySql("SELECT column_name FROM information_schema.columns");

const col = (
  table: string,
  column: string,
  data_type = "text",
  is_nullable = "YES"
): ColumnMeta => ({
  table_name: table,
  column_name: column,
  data_type,
  udt_name: data_type,
  is_nullable,
  column_default: null,
});

const tables = compareTables(["conversations", "user_memory"], ["conversations"]);
assert(
  tables.missing_in_production.join(",") === "user_memory",
  "compareTables missing"
);
assert(tables.extra_in_production.length === 0, "compareTables extra");

const columnDiffs = compareColumns(
  [col("conversations", "emotional_tone")],
  [col("conversations", "summary_updated_at")]
);
assert(columnDiffs.length === 2, "compareColumns count");
assert(
  columnDiffs.some((d) => d.kind === "missing_in_production" && d.column === "emotional_tone"),
  "missing emotional_tone"
);
assert(
  columnDiffs.some((d) => d.kind === "extra_in_production" && d.column === "summary_updated_at"),
  "extra summary_updated_at"
);

const mismatch = compareColumns(
  [col("user_memory", "importance", "smallint", "NO")],
  [col("user_memory", "importance", "integer", "NO")]
);
assert(mismatch[0]?.kind === "definition_mismatch", "column definition mismatch");

const idx = (name: string, def: string): IndexMeta => ({
  schemaname: "public",
  tablename: "user_memory",
  indexname: name,
  indexdef: def,
});

const indexDiffs = compareIndexes(
  [idx("idx_user_memory_user_importance", "CREATE INDEX ... ON user_memory (user_id, importance DESC)")],
  []
);
assert(indexDiffs[0]?.kind === "missing_in_production", "compareIndexes missing");

const memoryChecks = buildKnownMemoryChecks({
  stagingColumns: [
    col("conversations", "summary_updated_at", "timestamp with time zone"),
    col("conversations", "emotional_tone"),
    col("user_memory", "importance", "smallint"),
  ],
  productionColumns: [col("conversations", "summary_updated_at", "timestamp with time zone")],
  stagingIndexes: [
    idx("idx_user_memory_user_importance", "CREATE INDEX idx_user_memory_user_importance ON public.user_memory USING btree (user_id, importance DESC)"),
  ],
  productionIndexes: [],
});
assert(
  memoryChecks.find((c) => c.id === "conversations.emotional_tone")?.status === "drift",
  "memory check emotional_tone drift"
);
assert(
  memoryChecks.find((c) => c.id === "conversations.summary_updated_at")?.status === "aligned",
  "memory check summary_updated_at aligned"
);

const report: SchemaDriftReport = {
  generated_at: "2026-06-29",
  environments: {
    staging: { label: "staging", project_ref: "hdmoetcvlszrdukqpiia" },
    production: { label: "production", project_ref: "jnxrildlwvtxhtiwucbt" },
  },
  safety_notes: ["Read-only audit."],
  executive_summary: ["Drift detected."],
  tables: { missing_in_production: [], extra_in_production: [] },
  columns: [],
  indexes: [],
  rls: [],
  policies: [],
  known_memory_checks: memoryChecks,
  recommended_next_actions: ["Review manually."],
  explicitly_not_performed: ["No deploy."],
};
const md = renderMarkdownReport(report);
assert(md.includes("# Schema Drift Audit"), "markdown title");
assert(md.includes("conversations.emotional_tone"), "markdown memory section");

assert(
  resolveAuditSchemaMode(["node", "script"], {}) === "database-url",
  "default mode is database-url"
);
assert(
  resolveAuditSchemaMode(["node", "script", "--mode=cli"], {}) === "cli",
  "arg --mode=cli"
);
assert(
  resolveAuditSchemaMode(["node", "script"], { AUDIT_SCHEMA_SUPABASE_MODE: "cli" }) === "cli",
  "env AUDIT_SCHEMA_SUPABASE_MODE=cli"
);

const masked = maskSecrets(
  "failed postgres://user:secret@host:5432/db password=abc access_token=xyz"
);
assert(masked.includes("postgresql://***"), "maskSecrets postgres URL");
assert(!masked.includes("secret@host"), "maskSecrets hides password in URL");
assert(masked.includes("password=***"), "maskSecrets password=");

const cliNotes = buildAuditSafetyNotes("cli", "jnxrildlwvtxhtiwucbt");
assert(
  cliNotes.some((n) => n.includes("Management API tunnel")),
  "CLI safety notes include tunnel"
);
assert(cliNotes.some((n) => n.includes("No DATABASE_URL was used")), "CLI safety notes no DATABASE_URL");
assert(
  cliNotes.some((n) => n.includes("Local link restored to jnxrildlwvtxhtiwucbt")),
  "CLI safety notes restored ref"
);

const cliNotesSkipped = buildAuditSafetyNotes("cli", null);
assert(
  cliNotesSkipped.some((n) => n.includes("restore skipped because no original link")),
  "CLI safety notes skipped restore"
);

const cliReport: SchemaDriftReport = {
  ...report,
  safety_notes: cliNotes,
};
const cliMd = renderMarkdownReport(cliReport);
assert(cliMd.includes("No DATABASE_URL was used"), "markdown CLI safety notes");

console.log("=== schema-drift.cases.test.ts OK ===\n");
