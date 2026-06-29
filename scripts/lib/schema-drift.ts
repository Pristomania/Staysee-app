/**
 * Read-only schema drift comparison helpers (unit-testable, no DB I/O).
 */

export const FORBIDDEN_SQL_VERBS = [
  "ALTER",
  "CREATE",
  "DROP",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
] as const;

export type ForbiddenSqlVerb = (typeof FORBIDDEN_SQL_VERBS)[number];

export interface ColumnMeta {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
}

export interface IndexMeta {
  schemaname: string;
  tablename: string;
  indexname: string;
  indexdef: string;
}

export interface RlsMeta {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
}

export interface PolicyMeta {
  schemaname: string;
  tablename: string;
  policyname: string;
  permissive: string;
  roles: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

export interface ColumnDiff {
  table: string;
  column: string;
  kind: "missing_in_production" | "extra_in_production" | "definition_mismatch";
  staging: Partial<ColumnMeta> | null;
  production: Partial<ColumnMeta> | null;
  details?: string[];
}

export interface IndexDiff {
  indexname: string;
  kind: "missing_in_production" | "extra_in_production" | "definition_mismatch";
  staging: IndexMeta | null;
  production: IndexMeta | null;
}

export interface RlsDiff {
  table: string;
  kind: "missing_in_production" | "extra_in_production" | "definition_mismatch";
  staging: RlsMeta | null;
  production: RlsMeta | null;
  details?: string[];
}

export interface PolicyDiff {
  key: string;
  kind: "missing_in_production" | "extra_in_production" | "definition_mismatch";
  staging: PolicyMeta | null;
  production: PolicyMeta | null;
  details?: string[];
}

export interface KnownMemoryCheck {
  id: string;
  description: string;
  staging: "present" | "missing";
  production: "present" | "missing";
  status: "aligned" | "drift";
}

export interface SchemaDriftReport {
  generated_at: string;
  environments: {
    staging: { label: string; project_ref: string };
    production: { label: string; project_ref: string };
  };
  safety_notes: string[];
  executive_summary: string[];
  tables: {
    missing_in_production: string[];
    extra_in_production: string[];
  };
  columns: ColumnDiff[];
  indexes: IndexDiff[];
  rls: RlsDiff[];
  policies: PolicyDiff[];
  known_memory_checks: KnownMemoryCheck[];
  recommended_next_actions: string[];
  explicitly_not_performed: string[];
}

export const KNOWN_MEMORY_TARGETS = [
  {
    id: "conversations.summary_updated_at",
    table: "conversations",
    column: "summary_updated_at",
    description: "Rolling summary timestamp (migration 005)",
  },
  {
    id: "conversations.emotional_tone",
    table: "conversations",
    column: "emotional_tone",
    description: "Dominant emotional tone (migration 005)",
  },
  {
    id: "user_memory.importance",
    table: "user_memory",
    column: "importance",
    description: "Memory importance 1–5 (migration 005)",
  },
  {
    id: "user_memory.last_used_at",
    table: "user_memory",
    column: "last_used_at",
    description: "Last context packet use (migration 005)",
  },
  {
    id: "user_memory.updated_at",
    table: "user_memory",
    column: "updated_at",
    description: "Memory row update time (migration 005)",
  },
] as const;

const MEMORY_INDEX_PATTERN =
  /user_memory\s*\(\s*user_id\s*,\s*importance\s+desc\s*\)/i;

export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error("[audit:schema] Refusing to run empty SQL.");
  }
  const withoutComments = trimmed
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ");
  const upper = withoutComments.toUpperCase();
  if (!/^\s*(WITH\s+[\w\s,".]+\s+AS\s*\([\s\S]+\)\s*)?SELECT\b/i.test(withoutComments)) {
    throw new Error(
      "[audit:schema] Only SELECT queries are allowed (read-only audit)."
    );
  }
  for (const verb of FORBIDDEN_SQL_VERBS) {
    const re = new RegExp(`\\b${verb}\\b`, "i");
    if (re.test(upper)) {
      throw new Error(
        `[audit:schema] Forbidden SQL verb "${verb}" detected. Audit is read-only.`
      );
    }
  }
}

function columnKey(col: Pick<ColumnMeta, "table_name" | "column_name">): string {
  return `${col.table_name}.${col.column_name}`;
}

function columnSignature(col: ColumnMeta): string {
  return [
    col.data_type,
    col.udt_name,
    col.is_nullable,
    col.column_default ?? "null",
  ].join("|");
}

export function compareTables(
  stagingTables: string[],
  productionTables: string[]
): { missing_in_production: string[]; extra_in_production: string[] } {
  const staging = new Set(stagingTables);
  const production = new Set(productionTables);
  return {
    missing_in_production: [...staging].filter((t) => !production.has(t)).sort(),
    extra_in_production: [...production].filter((t) => !staging.has(t)).sort(),
  };
}

export function compareColumns(
  stagingColumns: ColumnMeta[],
  productionColumns: ColumnMeta[]
): ColumnDiff[] {
  const stagingMap = new Map(stagingColumns.map((c) => [columnKey(c), c]));
  const productionMap = new Map(productionColumns.map((c) => [columnKey(c), c]));
  const keys = new Set([...stagingMap.keys(), ...productionMap.keys()]);
  const diffs: ColumnDiff[] = [];

  for (const key of [...keys].sort()) {
    const staging = stagingMap.get(key) ?? null;
    const production = productionMap.get(key) ?? null;
    if (staging && !production) {
      diffs.push({
        table: staging.table_name,
        column: staging.column_name,
        kind: "missing_in_production",
        staging,
        production: null,
      });
      continue;
    }
    if (!staging && production) {
      diffs.push({
        table: production.table_name,
        column: production.column_name,
        kind: "extra_in_production",
        staging: null,
        production,
      });
      continue;
    }
    if (staging && production && columnSignature(staging) !== columnSignature(production)) {
      const details: string[] = [];
      if (staging.data_type !== production.data_type) {
        details.push(`data_type: staging=${staging.data_type}, production=${production.data_type}`);
      }
      if (staging.udt_name !== production.udt_name) {
        details.push(`udt_name: staging=${staging.udt_name}, production=${production.udt_name}`);
      }
      if (staging.is_nullable !== production.is_nullable) {
        details.push(
          `is_nullable: staging=${staging.is_nullable}, production=${production.is_nullable}`
        );
      }
      if ((staging.column_default ?? null) !== (production.column_default ?? null)) {
        details.push(
          `column_default: staging=${staging.column_default ?? "null"}, production=${production.column_default ?? "null"}`
        );
      }
      diffs.push({
        table: staging.table_name,
        column: staging.column_name,
        kind: "definition_mismatch",
        staging,
        production,
        details,
      });
    }
  }

  return diffs;
}

export function compareIndexes(
  stagingIndexes: IndexMeta[],
  productionIndexes: IndexMeta[]
): IndexDiff[] {
  const stagingByName = new Map(stagingIndexes.map((i) => [i.indexname, i]));
  const productionByName = new Map(productionIndexes.map((i) => [i.indexname, i]));
  const names = new Set([...stagingByName.keys(), ...productionByName.keys()]);
  const diffs: IndexDiff[] = [];

  for (const indexname of [...names].sort()) {
    const staging = stagingByName.get(indexname) ?? null;
    const production = productionByName.get(indexname) ?? null;
    if (staging && !production) {
      diffs.push({ indexname, kind: "missing_in_production", staging, production: null });
      continue;
    }
    if (!staging && production) {
      diffs.push({ indexname, kind: "extra_in_production", staging: null, production });
      continue;
    }
    if (staging && production && staging.indexdef !== production.indexdef) {
      diffs.push({
        indexname,
        kind: "definition_mismatch",
        staging,
        production,
      });
    }
  }

  return diffs;
}

function policyKey(policy: PolicyMeta): string {
  return `${policy.tablename}.${policy.policyname}`;
}

export function compareRls(
  stagingRls: RlsMeta[],
  productionRls: RlsMeta[]
): RlsDiff[] {
  const stagingMap = new Map(stagingRls.map((r) => [r.table_name, r]));
  const productionMap = new Map(productionRls.map((r) => [r.table_name, r]));
  const tables = new Set([...stagingMap.keys(), ...productionMap.keys()]);
  const diffs: RlsDiff[] = [];

  for (const table of [...tables].sort()) {
    const staging = stagingMap.get(table) ?? null;
    const production = productionMap.get(table) ?? null;
    if (staging && !production) {
      diffs.push({ table, kind: "missing_in_production", staging, production: null });
      continue;
    }
    if (!staging && production) {
      diffs.push({ table, kind: "extra_in_production", staging: null, production });
      continue;
    }
    if (
      staging &&
      production &&
      (staging.rls_enabled !== production.rls_enabled ||
        staging.rls_forced !== production.rls_forced)
    ) {
      const details: string[] = [];
      if (staging.rls_enabled !== production.rls_enabled) {
        details.push(
          `rls_enabled: staging=${staging.rls_enabled}, production=${production.rls_enabled}`
        );
      }
      if (staging.rls_forced !== production.rls_forced) {
        details.push(
          `rls_forced: staging=${staging.rls_forced}, production=${production.rls_forced}`
        );
      }
      diffs.push({
        table,
        kind: "definition_mismatch",
        staging,
        production,
        details,
      });
    }
  }

  return diffs;
}

export function comparePolicies(
  stagingPolicies: PolicyMeta[],
  productionPolicies: PolicyMeta[]
): PolicyDiff[] {
  const stagingMap = new Map(stagingPolicies.map((p) => [policyKey(p), p]));
  const productionMap = new Map(productionPolicies.map((p) => [policyKey(p), p]));
  const keys = new Set([...stagingMap.keys(), ...productionMap.keys()]);
  const diffs: PolicyDiff[] = [];

  for (const key of [...keys].sort()) {
    const staging = stagingMap.get(key) ?? null;
    const production = productionMap.get(key) ?? null;
    if (staging && !production) {
      diffs.push({ key, kind: "missing_in_production", staging, production: null });
      continue;
    }
    if (!staging && production) {
      diffs.push({ key, kind: "extra_in_production", staging: null, production });
      continue;
    }
    if (staging && production) {
      const details: string[] = [];
      const fields: Array<keyof PolicyMeta> = [
        "permissive",
        "roles",
        "cmd",
        "qual",
        "with_check",
      ];
      for (const field of fields) {
        if ((staging[field] ?? null) !== (production[field] ?? null)) {
          details.push(`${field}: differs`);
        }
      }
      if (details.length > 0) {
        diffs.push({
          key,
          kind: "definition_mismatch",
          staging,
          production,
          details,
        });
      }
    }
  }

  return diffs;
}

export function buildKnownMemoryChecks(input: {
  stagingColumns: ColumnMeta[];
  productionColumns: ColumnMeta[];
  stagingIndexes: IndexMeta[];
  productionIndexes: IndexMeta[];
}): KnownMemoryCheck[] {
  const checks: KnownMemoryCheck[] = KNOWN_MEMORY_TARGETS.map((target) => {
    const stagingPresent = input.stagingColumns.some(
      (c) => c.table_name === target.table && c.column_name === target.column
    );
    const productionPresent = input.productionColumns.some(
      (c) => c.table_name === target.table && c.column_name === target.column
    );
    return {
      id: target.id,
      description: target.description,
      staging: stagingPresent ? "present" : "missing",
      production: productionPresent ? "present" : "missing",
      status: stagingPresent === productionPresent ? "aligned" : "drift",
    } as KnownMemoryCheck;
  });

  const stagingIndex = input.stagingIndexes.find(
    (i) =>
      i.indexname === "idx_user_memory_user_importance" ||
      MEMORY_INDEX_PATTERN.test(i.indexdef)
  );
  const productionIndex = input.productionIndexes.find(
    (i) =>
      i.indexname === "idx_user_memory_user_importance" ||
      MEMORY_INDEX_PATTERN.test(i.indexdef)
  );

  checks.push({
    id: "idx_user_memory_user_importance",
    description:
      "Index on user_memory(user_id, importance DESC) — migration 005",
    staging: stagingIndex ? "present" : "missing",
    production: productionIndex ? "present" : "missing",
    status: !!stagingIndex === !!productionIndex ? "aligned" : "drift",
  });

  return checks;
}

export function buildExecutiveSummary(report: Omit<SchemaDriftReport, "executive_summary">): string[] {
  const lines: string[] = [];
  const tableDrift =
    report.tables.missing_in_production.length + report.tables.extra_in_production.length;
  const columnDrift = report.columns.length;
  const indexDrift = report.indexes.length;
  const rlsDrift = report.rls.length;
  const policyDrift = report.policies.length;
  const memoryDrift = report.known_memory_checks.filter((c) => c.status === "drift").length;

  if (
    tableDrift === 0 &&
    columnDrift === 0 &&
    indexDrift === 0 &&
    rlsDrift === 0 &&
    policyDrift === 0 &&
    memoryDrift === 0
  ) {
    lines.push("No schema drift detected between staging and production public schema.");
  } else {
    lines.push(
      `Drift detected: tables=${tableDrift}, columns=${columnDrift}, indexes=${indexDrift}, rls=${rlsDrift}, policies=${policyDrift}, known_memory=${memoryDrift}.`
    );
  }

  if (memoryDrift > 0) {
    const drifted = report.known_memory_checks
      .filter((c) => c.status === "drift")
      .map((c) => c.id);
    lines.push(`Known memory-related drift: ${drifted.join(", ")}.`);
  }

  return lines;
}

function renderList(title: string, items: string[]): string {
  if (items.length === 0) return `## ${title}\n\nNone.\n`;
  return `## ${title}\n\n${items.map((i) => `- ${i}`).join("\n")}\n`;
}

function renderColumnDiffs(diffs: ColumnDiff[]): string {
  if (diffs.length === 0) return "## Column differences\n\nNone.\n";
  const lines = diffs.map((d) => {
    const base = `- **${d.table}.${d.column}** (${d.kind})`;
    if (d.details?.length) return `${base}\n  - ${d.details.join("\n  - ")}`;
    return base;
  });
  return `## Column differences\n\n${lines.join("\n")}\n`;
}

function renderIndexDiffs(diffs: IndexDiff[]): string {
  if (diffs.length === 0) return "## Index differences\n\nNone.\n";
  const lines = diffs.map((d) => {
    if (d.kind === "definition_mismatch") {
      return `- **${d.indexname}** (definition_mismatch)\n  - staging: \`${d.staging?.indexdef}\`\n  - production: \`${d.production?.indexdef}\``;
    }
    return `- **${d.indexname}** (${d.kind})`;
  });
  return `## Index differences\n\n${lines.join("\n")}\n`;
}

function renderRlsDiffs(diffs: RlsDiff[]): string {
  if (diffs.length === 0) return "## RLS differences\n\nNone.\n";
  const lines = diffs.map((d) => {
    const base = `- **${d.table}** (${d.kind})`;
    if (d.details?.length) return `${base}\n  - ${d.details.join("\n  - ")}`;
    return base;
  });
  return `## RLS differences\n\n${lines.join("\n")}\n`;
}

function renderPolicyDiffs(diffs: PolicyDiff[]): string {
  if (diffs.length === 0) return "## Policy differences\n\nNone.\n";
  const lines = diffs.map((d) => {
    const base = `- **${d.key}** (${d.kind})`;
    if (d.details?.length) return `${base}\n  - ${d.details.join("\n  - ")}`;
    return base;
  });
  return `## Policy differences\n\n${lines.join("\n")}\n`;
}

function renderKnownMemoryChecks(checks: KnownMemoryCheck[]): string {
  const lines = checks.map(
    (c) =>
      `- **${c.id}**: staging=${c.staging}, production=${c.production} → ${c.status} (${c.description})`
  );
  return `## Known memory-related checks\n\n${lines.join("\n")}\n`;
}

export function renderMarkdownReport(report: SchemaDriftReport): string {
  const sections = [
    "# Schema Drift Audit",
    "",
    `**Date:** ${report.generated_at}`,
    "",
    "## Compared environments",
    "",
    `- **Staging:** ${report.environments.staging.label} (\`${report.environments.staging.project_ref}\`)`,
    `- **Production:** ${report.environments.production.label} (\`${report.environments.production.project_ref}\`)`,
    "",
    "## Safety notes",
    "",
    ...report.safety_notes.map((n) => `- ${n}`),
    "",
    "## Executive summary",
    "",
    ...report.executive_summary.map((n) => `- ${n}`),
    "",
    renderList(
      "Missing tables (in staging, not production)",
      report.tables.missing_in_production
    ),
    renderList(
      "Extra tables (in production, not staging)",
      report.tables.extra_in_production
    ),
    renderColumnDiffs(report.columns),
    renderIndexDiffs(report.indexes),
    renderRlsDiffs(report.rls),
    renderPolicyDiffs(report.policies),
    renderKnownMemoryChecks(report.known_memory_checks),
    "## Recommended next actions",
    "",
    ...report.recommended_next_actions.map((n) => `- ${n}`),
    "",
    "## Explicitly not performed",
    "",
    ...report.explicitly_not_performed.map((n) => `- ${n}`),
    "",
  ];
  return sections.join("\n");
}

export const DEFAULT_RECOMMENDED_ACTIONS = [
  "Review this diff manually — do not apply migration 005 or any full migration bundle blindly.",
  "Classify each difference as used-by-code, unused, or legacy.",
  "Prepare a separate additive migration only for items confirmed necessary.",
  "Test any proposed schema change on staging first.",
  "Require explicit approval before applying changes to production.",
];

export const DEFAULT_NOT_PERFORMED = [
  "No ALTER / CREATE / DROP / DML executed.",
  "No Supabase migrations applied.",
  "No backfill or consolidate jobs run.",
  "No production data modified.",
  "No deploy.",
];
