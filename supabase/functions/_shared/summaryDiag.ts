/**
 * Smoke-gated conversation_summary persistence diagnostics (function logs only).
 */

export const SUMMARY_DIAG_TITLE_PREFIX = "__SMOKE__ summary persistence diagnostic";

const SUMMARY_SMOKE_TITLE_PREFIXES = [
  SUMMARY_DIAG_TITLE_PREFIX,
  "__SMOKE__ fact evolution diagnostic",
  "__SMOKE__ fact evolution v1",
  "__SMOKE__ fact evolution",
];

export function isSummaryDiagConversation(title: string | null | undefined): boolean {
  if (!title) return false;
  return SUMMARY_SMOKE_TITLE_PREFIXES.some((p) => title.startsWith(p));
}

export interface SummaryDiagContext {
  enabled: boolean;
  clientType: "service" | "user";
  path: "eager" | "background";
  title?: string | null;
}

function log(phase: string, data: Record<string, unknown>): void {
  console.log(`SUMMARY_DIAG ${phase}: ${JSON.stringify(data)}`);
}

export function summaryDiagStart(input: {
  enabled: boolean;
  userId: string;
  conversationId: string;
  title?: string | null;
  path: "eager" | "background";
  clientType: "service" | "user";
  dbMessageCount?: number;
  currentSummaryBytes?: number;
  currentSummaryUpdatedAt?: string | null;
}): void {
  if (!input.enabled) return;
  log("start", {
    user_id: input.userId,
    conversation_id: input.conversationId,
    title: input.title ?? null,
    path: input.path,
    client_type: input.clientType,
    db_message_count: input.dbMessageCount ?? null,
    current_summary_bytes: input.currentSummaryBytes ?? null,
    current_summary_updated_at: input.currentSummaryUpdatedAt ?? null,
  });
}

export function summaryDiagBuild(input: {
  enabled: boolean;
  attempted: boolean;
  sourceMessageCount: number;
  resultBytes?: number;
  peopleCount?: number;
  importantEventsCount?: number;
  openLoopsCount?: number;
}): void {
  if (!input.enabled) return;
  log("build", {
    attempted: input.attempted,
    source_message_count: input.sourceMessageCount,
    result_bytes: input.resultBytes ?? null,
    structured_field_counts: {
      people: input.peopleCount ?? null,
      important_events: input.importantEventsCount ?? null,
      open_loops: input.openLoopsCount ?? null,
    },
  });
}

export function summaryDiagSaveAttempt(input: {
  enabled: boolean;
  clientType: "service" | "user";
  updatePayloadKeys: string[];
  whereId: string;
  summaryBytesToSave: number;
}): void {
  if (!input.enabled) return;
  log("save_attempt", {
    attempted: true,
    client_type: input.clientType,
    update_payload_keys: input.updatePayloadKeys,
    where_id: input.whereId,
    summary_bytes_to_save: input.summaryBytesToSave,
  });
}

export function summaryDiagSaveResult(input: {
  enabled: boolean;
  success: boolean;
  usedTimestampFallback?: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  postSaveSummaryBytes?: number;
  postSaveSummaryUpdatedAt?: string | null;
}): void {
  if (!input.enabled) return;
  log("save_result", {
    success: input.success,
    used_timestamp_fallback: input.usedTimestampFallback ?? null,
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ?? null,
    post_save_summary_bytes: input.postSaveSummaryBytes ?? null,
    post_save_summary_updated_at: input.postSaveSummaryUpdatedAt ?? null,
  });
}

export function summaryDiagMemoryRefresh(input: {
  enabled: boolean;
  attempted: boolean;
  candidatesPreview?: string[];
  lifeContextRows?: string[];
}): void {
  if (!input.enabled) return;
  log("memory_refresh", {
    attempted: input.attempted,
    user_memory_candidates: input.candidatesPreview?.map((c) => c.slice(0, 80)) ?? [],
    user_memory_rows_after: input.lifeContextRows?.map((r) => r.slice(0, 120)) ?? [],
  });
}
