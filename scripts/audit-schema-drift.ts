/**
 * Read-only schema drift audit: staging vs production.
 *
 * DATABASE_URL mode (default):
 *   STAGING_DATABASE_URL
 *   PRODUCTION_DATABASE_URL
 *   npm run audit:schema
 *
 * Supabase CLI linked mode:
 *   npm run audit:schema:cli
 *   or AUDIT_SCHEMA_SUPABASE_MODE=cli
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  assertReadOnlySql,
  buildAuditSafetyNotes,
  buildExecutiveSummary,
  buildKnownMemoryChecks,
  compareColumns,
  compareIndexes,
  comparePolicies,
  compareRls,
  compareTables,
  DEFAULT_NOT_PERFORMED,
  DEFAULT_RECOMMENDED_ACTIONS,
  maskSecrets,
  renderMarkdownReport,
  resolveAuditSchemaMode,
  type AuditSchemaMode,
  type ColumnMeta,
  type IndexMeta,
  type PolicyMeta,
  type RlsMeta,
  type SchemaDriftReport,
} from "./lib/schema-drift.ts";

const DEFAULT_STAGING_PROJECT_REF = "hdmoetcvlszrdukqpiia";
const DEFAULT_PRODUCTION_PROJECT_REF = "jnxrildlwvtxhtiwucbt";
const LINKED_PROJECT_REF_FILE = resolve("supabase/.temp/project-ref");

const SQL = {
  tables: `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `,
  columns: `
    SELECT
      table_name,
      column_name,
      data_type,
      udt_name,
      is_nullable,
      column_default::text AS column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position;
  `,
  indexes: `
    SELECT schemaname, tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname;
  `,
  rls: `
    SELECT
      c.relname AS table_name,
      c.relrowsecurity AS rls_enabled,
      c.relforcerowsecurity AS rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    ORDER BY c.relname;
  `,
  policies: `
    SELECT
      schemaname,
      tablename,
      policyname,
      permissive,
      roles::text AS roles,
      cmd,
      qual,
      with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname;
  `,
} as const;

function resolveProjectRefs(): { stagingRef: string; productionRef: string } {
  return {
    stagingRef: process.env.STAGING_PROJECT_REF?.trim() || DEFAULT_STAGING_PROJECT_REF,
    productionRef:
      process.env.PRODUCTION_PROJECT_REF?.trim() || DEFAULT_PRODUCTION_PROJECT_REF,
  };
}

function requireDatabaseUrls(): { stagingUrl: string; productionUrl: string } {
  const stagingUrl = process.env.STAGING_DATABASE_URL?.trim();
  const productionUrl = process.env.PRODUCTION_DATABASE_URL?.trim();
  const missing: string[] = [];
  if (!stagingUrl) missing.push("STAGING_DATABASE_URL");
  if (!productionUrl) missing.push("PRODUCTION_DATABASE_URL");
  if (missing.length > 0) {
    console.error("[audit:schema] Missing required environment variables:");
    for (const name of missing) console.error(`  - ${name}`);
    console.error("");
    console.error("Set Postgres connection URLs for staging and production.");
    console.error("Or run via Supabase CLI linked mode: npm run audit:schema:cli");
    console.error("This audit is read-only and does not use Supabase service keys in code.");
    process.exit(1);
  }
  return { stagingUrl: stagingUrl!, productionUrl: productionUrl! };
}

function readLinkedProjectRef(): string | null {
  try {
    const content = readFileSync(LINKED_PROJECT_REF_FILE, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

function execSupabase(args: string[]): string {
  try {
    return execFileSync("npx", ["supabase", ...args], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
  } catch (error) {
    const err = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const stderr =
      typeof err.stderr === "string"
        ? err.stderr
        : err.stderr instanceof Buffer
          ? err.stderr.toString("utf8")
          : "";
    const stdout =
      typeof err.stdout === "string"
        ? err.stdout
        : err.stdout instanceof Buffer
          ? err.stdout.toString("utf8")
          : "";
    const parts = [err.message, stderr, stdout].filter(Boolean).join("\n");
    throw new Error(`[audit:schema] Supabase CLI failed: ${maskSecrets(parts)}`);
  }
}

function linkProjectRef(projectRef: string): void {
  execSupabase(["link", "--project-ref", projectRef, "--yes"]);
}

function parseSupabaseQueryOutput(stdout: string): Record<string, unknown>[] {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `[audit:schema] Could not parse Supabase CLI output:\n${maskSecrets(stdout.slice(0, 500))}`
    );
  }
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as { rows?: Record<string, unknown>[] };
  return parsed.rows ?? [];
}

function writeTmpSqlFile(sql: string): string {
  const tmpPath = join(tmpdir(), `staysee-schema-audit-${randomUUID()}.sql`);
  writeFileSync(tmpPath, `${sql.trim()}\n`, "utf8");
  return tmpPath;
}

function removeTmpSqlFile(tmpPath: string): void {
  try {
    unlinkSync(tmpPath);
  } catch {
    /* ignore */
  }
}

function runReadOnlyQueryDbUrl(dbUrl: string, sql: string): Record<string, unknown>[] {
  assertReadOnlySql(sql);
  const tmpPath = writeTmpSqlFile(sql);
  try {
    const stdout = execSupabase(["db", "query", "--db-url", dbUrl, "-f", tmpPath]);
    return parseSupabaseQueryOutput(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(maskSecrets(message));
  } finally {
    removeTmpSqlFile(tmpPath);
  }
}

function runReadOnlyQueryLinked(sql: string): Record<string, unknown>[] {
  assertReadOnlySql(sql);
  const tmpPath = writeTmpSqlFile(sql);
  try {
    const stdout = execSupabase(["db", "query", "--linked", "-f", tmpPath]);
    return parseSupabaseQueryOutput(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(maskSecrets(message));
  } finally {
    removeTmpSqlFile(tmpPath);
  }
}

function asString(value: unknown): string {
  return value == null ? "" : String(value);
}

function mapColumns(rows: Record<string, unknown>[]): ColumnMeta[] {
  return rows.map((row) => ({
    table_name: asString(row.table_name),
    column_name: asString(row.column_name),
    data_type: asString(row.data_type),
    udt_name: asString(row.udt_name),
    is_nullable: asString(row.is_nullable),
    column_default: row.column_default == null ? null : asString(row.column_default),
  }));
}

function mapIndexes(rows: Record<string, unknown>[]): IndexMeta[] {
  return rows.map((row) => ({
    schemaname: asString(row.schemaname),
    tablename: asString(row.tablename),
    indexname: asString(row.indexname),
    indexdef: asString(row.indexdef),
  }));
}

function mapRls(rows: Record<string, unknown>[]): RlsMeta[] {
  return rows.map((row) => ({
    table_name: asString(row.table_name),
    rls_enabled: row.rls_enabled === true || row.rls_enabled === "t",
    rls_forced: row.rls_forced === true || row.rls_forced === "t",
  }));
}

function mapPolicies(rows: Record<string, unknown>[]): PolicyMeta[] {
  return rows.map((row) => ({
    schemaname: asString(row.schemaname),
    tablename: asString(row.tablename),
    policyname: asString(row.policyname),
    permissive: asString(row.permissive),
    roles: asString(row.roles),
    cmd: asString(row.cmd),
    qual: row.qual == null ? null : asString(row.qual),
    with_check: row.with_check == null ? null : asString(row.with_check),
  }));
}

type QueryRunner = (sql: string) => Record<string, unknown>[];

function fetchEnvironmentSchema(runQuery: QueryRunner, label: string) {
  console.log(`[audit:schema] Reading ${label} schema (read-only)...`);
  const tableRows = runQuery(SQL.tables);
  const columnRows = runQuery(SQL.columns);
  const indexRows = runQuery(SQL.indexes);
  const rlsRows = runQuery(SQL.rls);
  const policyRows = runQuery(SQL.policies);

  return {
    tables: tableRows.map((r) => asString(r.table_name)).filter(Boolean),
    columns: mapColumns(columnRows),
    indexes: mapIndexes(indexRows),
    rls: mapRls(rlsRows),
    policies: mapPolicies(policyRows),
  };
}

function fetchEnvironmentSchemaCli(projectRef: string, label: string) {
  console.log(`[audit:schema] Linking ${label} (${projectRef})...`);
  linkProjectRef(projectRef);
  return fetchEnvironmentSchema(runReadOnlyQueryLinked, label);
}

function printConsoleSummary(report: SchemaDriftReport): void {
  console.log("\n[audit:schema] Executive summary");
  for (const line of report.executive_summary) console.log(`  - ${line}`);

  console.log("\n[audit:schema] Known memory-related checks");
  for (const check of report.known_memory_checks) {
    console.log(
      `  - ${check.id}: staging=${check.staging}, production=${check.production} (${check.status})`
    );
  }

  if (report.columns.length > 0) {
    console.log(`\n[audit:schema] Column diffs: ${report.columns.length}`);
    for (const diff of report.columns.slice(0, 20)) {
      console.log(`  - ${diff.table}.${diff.column}: ${diff.kind}`);
    }
    if (report.columns.length > 20) {
      console.log(`  ... and ${report.columns.length - 20} more (see markdown report)`);
    }
  }
}

async function main(): Promise<void> {
  const mode: AuditSchemaMode = resolveAuditSchemaMode();
  const { stagingRef, productionRef } = resolveProjectRefs();
  let restoredLinkRef: string | null = null;
  let originalLinkRef: string | null = null;

  if (mode === "cli") {
    originalLinkRef = readLinkedProjectRef();
    console.log(
      `[audit:schema] CLI linked mode (staging=${stagingRef}, production=${productionRef})`
    );
    if (originalLinkRef) {
      console.log(`[audit:schema] Saved original linked project ref for restore.`);
    } else {
      console.log("[audit:schema] No original linked project ref found; restore will be skipped.");
    }
  }

  let staging;
  let production;

  try {
    if (mode === "cli") {
      staging = fetchEnvironmentSchemaCli(stagingRef, "staging");
      production = fetchEnvironmentSchemaCli(productionRef, "production");
    } else {
      const { stagingUrl, productionUrl } = requireDatabaseUrls();
      staging = fetchEnvironmentSchema((sql) => runReadOnlyQueryDbUrl(stagingUrl, sql), "staging");
      production = fetchEnvironmentSchema(
        (sql) => runReadOnlyQueryDbUrl(productionUrl, sql),
        "production"
      );
    }
  } finally {
    if (mode === "cli") {
      if (originalLinkRef) {
        console.log(`[audit:schema] Restoring original linked project ref...`);
        linkProjectRef(originalLinkRef);
        restoredLinkRef = originalLinkRef;
      } else {
        console.log("[audit:schema] Local link restore skipped because no original link.");
      }
    }
  }

  const generatedAt = new Date().toISOString().slice(0, 10);
  const tables = compareTables(staging!.tables, production!.tables);
  const columns = compareColumns(staging!.columns, production!.columns);
  const indexes = compareIndexes(staging!.indexes, production!.indexes);
  const rls = compareRls(staging!.rls, production!.rls);
  const policies = comparePolicies(staging!.policies, production!.policies);
  const known_memory_checks = buildKnownMemoryChecks({
    stagingColumns: staging!.columns,
    productionColumns: production!.columns,
    stagingIndexes: staging!.indexes,
    productionIndexes: production!.indexes,
  });

  const baseReport: Omit<SchemaDriftReport, "executive_summary"> = {
    generated_at: generatedAt,
    environments: {
      staging: { label: "staging", project_ref: stagingRef },
      production: { label: "production", project_ref: productionRef },
    },
    safety_notes: buildAuditSafetyNotes(mode, restoredLinkRef),
    tables,
    columns,
    indexes,
    rls,
    policies,
    known_memory_checks,
    recommended_next_actions: DEFAULT_RECOMMENDED_ACTIONS,
    explicitly_not_performed: DEFAULT_NOT_PERFORMED,
  };

  const report: SchemaDriftReport = {
    ...baseReport,
    executive_summary: buildExecutiveSummary({
      ...baseReport,
      executive_summary: [],
    }),
  };

  const markdown = renderMarkdownReport(report);
  const auditsDir = resolve("docs/audits");
  mkdirSync(auditsDir, { recursive: true });
  const mdPath = join(auditsDir, `schema-drift-${generatedAt}.md`);
  const jsonPath = join(auditsDir, `schema-drift-${generatedAt}.json`);
  writeFileSync(mdPath, markdown, "utf8");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

  printConsoleSummary(report);
  console.log(`\n[audit:schema] Markdown report: ${mdPath}`);
  console.log(`[audit:schema] JSON report: ${jsonPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[audit:schema] ${maskSecrets(message)}`);
  process.exit(1);
});
