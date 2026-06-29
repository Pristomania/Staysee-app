/**
 * Read-only schema drift audit: staging vs production.
 *
 * Requires:
 *   STAGING_DATABASE_URL
 *   PRODUCTION_DATABASE_URL
 *
 * Run:
 *   npm run audit:schema
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  assertReadOnlySql,
  buildExecutiveSummary,
  buildKnownMemoryChecks,
  compareColumns,
  compareIndexes,
  comparePolicies,
  compareRls,
  compareTables,
  DEFAULT_NOT_PERFORMED,
  DEFAULT_RECOMMENDED_ACTIONS,
  renderMarkdownReport,
  type ColumnMeta,
  type IndexMeta,
  type PolicyMeta,
  type RlsMeta,
  type SchemaDriftReport,
} from "./lib/schema-drift.ts";

const STAGING_PROJECT_REF = "hdmoetcvlszrdukqpiia";
const PRODUCTION_PROJECT_REF = "jnxrildlwvtxhtiwucbt";

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
    console.error("This audit is read-only and does not use Supabase service keys in code.");
    process.exit(1);
  }
  return { stagingUrl: stagingUrl!, productionUrl: productionUrl! };
}

function parseSupabaseQueryOutput(stdout: string): Record<string, unknown>[] {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `[audit:schema] Could not parse Supabase CLI output:\n${stdout.slice(0, 500)}`
    );
  }
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as { rows?: Record<string, unknown>[] };
  return parsed.rows ?? [];
}

function runReadOnlyQuery(dbUrl: string, sql: string): Record<string, unknown>[] {
  assertReadOnlySql(sql);
  const tmpPath = join(tmpdir(), `staysee-schema-audit-${randomUUID()}.sql`);
  writeFileSync(tmpPath, `${sql.trim()}\n`, "utf8");
  try {
    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const stdout = execFileSync(
      command,
      ["supabase", "db", "query", "--db-url", dbUrl, "-f", tmpPath],
      {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    return parseSupabaseQueryOutput(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[audit:schema] Query failed: ${message}`);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
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

async function fetchEnvironmentSchema(dbUrl: string, label: string) {
  console.log(`[audit:schema] Reading ${label} schema (read-only)...`);
  const tableRows = runReadOnlyQuery(dbUrl, SQL.tables);
  const columnRows = runReadOnlyQuery(dbUrl, SQL.columns);
  const indexRows = runReadOnlyQuery(dbUrl, SQL.indexes);
  const rlsRows = runReadOnlyQuery(dbUrl, SQL.rls);
  const policyRows = runReadOnlyQuery(dbUrl, SQL.policies);

  return {
    tables: tableRows.map((r) => asString(r.table_name)).filter(Boolean),
    columns: mapColumns(columnRows),
    indexes: mapIndexes(indexRows),
    rls: mapRls(rlsRows),
    policies: mapPolicies(policyRows),
  };
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
  const { stagingUrl, productionUrl } = requireDatabaseUrls();

  const generatedAt = new Date().toISOString().slice(0, 10);
  const staging = await fetchEnvironmentSchema(stagingUrl, "staging");
  const production = await fetchEnvironmentSchema(productionUrl, "production");

  const tables = compareTables(staging.tables, production.tables);
  const columns = compareColumns(staging.columns, production.columns);
  const indexes = compareIndexes(staging.indexes, production.indexes);
  const rls = compareRls(staging.rls, production.rls);
  const policies = comparePolicies(staging.policies, production.policies);
  const known_memory_checks = buildKnownMemoryChecks({
    stagingColumns: staging.columns,
    productionColumns: production.columns,
    stagingIndexes: staging.indexes,
    productionIndexes: production.indexes,
  });

  const baseReport: Omit<SchemaDriftReport, "executive_summary"> = {
    generated_at: generatedAt,
    environments: {
      staging: { label: "staging", project_ref: STAGING_PROJECT_REF },
      production: { label: "production", project_ref: PRODUCTION_PROJECT_REF },
    },
    safety_notes: [
      "Read-only audit using SELECT queries against information_schema and pg_catalog views.",
      "All SQL strings are checked for forbidden verbs before execution.",
      "No migrations, DML, DDL, deploy, backfill, or consolidate were run.",
    ],
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
  console.error(`[audit:schema] ${message}`);
  process.exit(1);
});
