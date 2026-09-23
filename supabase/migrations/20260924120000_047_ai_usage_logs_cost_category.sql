-- Splits ai_usage_logs (built in 040_memory_v3_lifecycle_cost_tracking.sql)
-- into automatic spend (anything the system does on its own in response to
-- real user activity: chat replies, summaries, cross-memory synthesis, both
-- Memory V3 extractor/reconciler stages) versus technical spend (manual,
-- one-off invocations: this project's backfill scripts, future smoke
-- tests). Defaults to 'technical' -- every row logged so far is
-- development-phase spend with no real outside users yet, so the default
-- correctly reclassifies all history without a separate backfill UPDATE.
-- Everything logged through buildUsageLogRow from this point on defaults to
-- 'automatic' instead (see usageAnalytics.ts); only a caller that
-- explicitly asks for 'technical' gets it.

ALTER TABLE public.ai_usage_logs
  ADD COLUMN IF NOT EXISTS cost_category text NOT NULL DEFAULT 'technical'
    CHECK (cost_category IN ('automatic', 'technical'));
