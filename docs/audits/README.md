# Schema drift audits

Read-only comparisons between StaySee Supabase environments.

## What this audit does

`npm run audit:schema` runs `scripts/audit-schema-drift.ts`, which:

- connects to **staging** and **production** Postgres using connection URLs from env vars;
- reads metadata only (`information_schema`, `pg_indexes`, `pg_policies`, `pg_class`);
- compares the `public` schema for tables, columns, indexes, RLS flags, and policies;
- writes a dated report under `docs/audits/schema-drift-YYYY-MM-DD.md` (and `.json`);
- prints a short executive summary to the console.

## Safety

- **Read-only** — only `SELECT` queries are allowed.
- Every SQL string is checked for forbidden verbs (`ALTER`, `CREATE`, `DROP`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `GRANT`, `REVOKE`) before execution.
- Does **not** apply migrations.
- Does **not** modify production data.
- Does **not** deploy edge functions or frontend.

## Required environment variables

```bash
STAGING_DATABASE_URL=postgresql://...
PRODUCTION_DATABASE_URL=postgresql://...
```

Use Postgres connection strings (direct DB URL), not Supabase anon/service keys.

If either variable is missing, the script exits with a clear message and does not connect.

## How to run

```bash
npm run audit:schema
```

Reports are written to:

```text
docs/audits/schema-drift-YYYY-MM-DD.md
docs/audits/schema-drift-YYYY-MM-DD.json
```

## How to interpret the report

1. **Executive summary** — high-level drift counts.
2. **Missing / extra tables** — table presence differences.
3. **Column / index / RLS / policy differences** — detailed drift.
4. **Known memory-related checks** — focused status for migration 005 memory fields:
   - `conversations.summary_updated_at`
   - `conversations.emotional_tone`
   - `user_memory.importance`, `last_used_at`, `updated_at`
   - `idx_user_memory_user_importance` (or equivalent index on `user_memory(user_id, importance)`)
5. **Recommended next actions** — manual review workflow; never suggests blind full migration apply.

### Classifying drift

For each difference:

| Class | Meaning |
|-------|---------|
| used-by-code | Runtime or migrations expect this object |
| unused | Legacy / not referenced |
| legacy | Intentionally different between envs |

Only after manual classification should you prepare a **separate additive migration** for production, test on staging first, and get explicit approval.

## Related migration

Migration `supabase/migrations/20260524231158_005_layer4_memory_and_context.sql` adds several objects. The audit highlights known memory-related items but does **not** recommend applying the full migration bundle blindly.
