/**
 * Internal memory-path diagnostics — Supabase logs only, smoke conversations.
 */

import type { StructuredMemory } from "./memory.ts";
import type { FactEvolutionDecision } from "./factEvolution.ts";

export const MEMORY_DIAG_TITLE_PREFIX = "__SMOKE__ fact evolution diagnostic";

const SMOKE_TITLE_PREFIXES = [
  MEMORY_DIAG_TITLE_PREFIX,
  "__SMOKE__ fact evolution v1",
  "__SMOKE__ fact evolution",
];

export function isMemoryDiagConversation(title: string | null | undefined): boolean {
  if (!title) return false;
  return SMOKE_TITLE_PREFIXES.some((p) => title.startsWith(p));
}

function log(phase: string, data: Record<string, unknown>): void {
  console.log(`MEMORY_DIAG ${phase}: ${JSON.stringify(data)}`);
}

export function memoryDiagStart(input: {
  enabled: boolean;
  userId: string;
  conversationId: string;
  requestMessageCount?: number;
  dbMessageCount?: number;
  lastMessageCreatedAt?: string | null;
}): void {
  if (!input.enabled) return;
  log("start", {
    user_id: input.userId,
    conversation_id: input.conversationId,
    request_message_count: input.requestMessageCount ?? null,
    db_message_count: input.dbMessageCount ?? null,
    last_message_created_at: input.lastMessageCreatedAt ?? null,
  });
}

export function memoryDiagSummaryDecision(input: {
  enabled: boolean;
  path: "eager" | "background";
  shouldRefresh: boolean;
  reason: string;
  currentSummaryExists: boolean;
  currentSummaryBytes: number;
  summaryUpdatedAt: string | null;
  transcriptLen: number;
  messagesSinceSummary: number;
  clientConnected?: boolean;
}): void {
  if (!input.enabled) return;
  log("summary_decision", {
    path: input.path,
    should_refresh: input.shouldRefresh,
    reason: input.reason,
    current_summary_exists: input.currentSummaryExists,
    current_summary_bytes: input.currentSummaryBytes,
    summary_updated_at: input.summaryUpdatedAt,
    transcript_len: input.transcriptLen,
    messages_since_summary: input.messagesSinceSummary,
    client_connected: input.clientConnected ?? null,
  });
}

export function memoryDiagSummaryBuild(input: {
  enabled: boolean;
  attempted: boolean;
  sourceMessageCount: number;
  userTurnCount: number;
  resultBytes?: number;
  memory?: StructuredMemory | null;
  modelFailed?: boolean;
}): void {
  if (!input.enabled) return;
  const mem = input.memory;
  log("summary_build", {
    attempted: input.attempted,
    source_message_count: input.sourceMessageCount,
    user_turn_count: input.userTurnCount,
    result_bytes: input.resultBytes ?? null,
    structured_field_counts: mem
      ? {
          people: mem.people.length,
          important_events: mem.important_events.length,
          preferences: mem.preferences.length,
          themes: mem.themes.length,
          open_loops: mem.open_loops.length,
        }
      : null,
    people_preview: mem?.people.slice(0, 4).map((p) => p.slice(0, 80)) ?? [],
  });
}

export function memoryDiagSummarySave(input: {
  enabled: boolean;
  attempted: boolean;
  success: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  postSaveSummaryBytes?: number;
  postSaveSummaryUpdatedAt?: string | null;
}): void {
  if (!input.enabled) return;
  log("summary_save", {
    attempted: input.attempted,
    success: input.success,
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ?? null,
    post_save_summary_bytes: input.postSaveSummaryBytes ?? null,
    post_save_summary_updated_at: input.postSaveSummaryUpdatedAt ?? null,
  });
}

export function memoryDiagCrossMemory(input: {
  enabled: boolean;
  candidatesCount: number;
  candidatesPreview: string[];
  admittedCount: number;
  blockedCount: number;
  blockReasons?: string[];
}): void {
  if (!input.enabled) return;
  log("cross_memory", {
    candidates_count: input.candidatesCount,
    candidates_preview: input.candidatesPreview.map((c) => c.slice(0, 100)),
    admitted_count: input.admittedCount,
    blocked_count: input.blockedCount,
    block_reasons: input.blockReasons?.slice(0, 5) ?? [],
  });
}

export function memoryDiagFactEvolution(input: {
  enabled: boolean;
  candidate: string;
  parsedSlot?: string | null;
  action?: string;
  insertedContent?: string;
  ignoredReason?: string;
  deletedRows?: number;
}): void {
  if (!input.enabled) return;
  log("fact_evolution", {
    candidate: input.candidate.slice(0, 100),
    parsed_slot: input.parsedSlot ?? null,
    action: input.action ?? null,
    inserted_content: input.insertedContent?.slice(0, 120) ?? null,
    ignored_reason: input.ignoredReason ?? null,
    deleted_rows: input.deletedRows ?? 0,
  });
}

export function memoryDiagUserMemoryAfter(input: {
  enabled: boolean;
  lifeContextRows: string[];
  communicationRows: string[];
}): void {
  if (!input.enabled) return;
  log("user_memory_after", {
    life_context_rows: input.lifeContextRows.map((r) => r.slice(0, 120)),
    communication_rows: input.communicationRows.map((r) => r.slice(0, 120)),
  });
}

/** Log background summary gate inputs (smoke only). */
export function memoryDiagBackgroundGate(input: {
  enabled: boolean;
  hasPacket: boolean;
  hasConversationId: boolean;
  hasResultContent: boolean;
  isCalmFallback: boolean;
  clientConnected: boolean;
}): void {
  if (!input.enabled) return;
  log("background_gate", {
    has_packet: input.hasPacket,
    has_conversation_id: input.hasConversationId,
    has_result_content: input.hasResultContent,
    is_calm_fallback: input.isCalmFallback,
    client_connected: input.clientConnected,
    summary_branch_will_run:
      input.hasConversationId &&
      input.hasPacket &&
      input.hasResultContent &&
      !input.isCalmFallback,
  });
}

/** Explain why shouldUpdateConversationSummary returned true/false (diag only). */
export function explainSummaryRefreshDecision(check: {
  hasCorrections: boolean;
  conversationSummary: string | null;
  summaryUpdatedAt: string | null;
  messagesSinceSummary: number;
  transcriptLen: number;
}): { should: boolean; reason: string } {
  if (check.hasCorrections) return { should: true, reason: "corrections" };
  if (!check.conversationSummary?.trim() && check.transcriptLen >= 4) {
    return { should: true, reason: "no_summary" };
  }
  if (check.transcriptLen >= 6 && !check.conversationSummary?.trim()) {
    return { should: true, reason: "empty_summary_shell" };
  }
  if (check.messagesSinceSummary >= 4) {
    return { should: true, reason: "message_count" };
  }
  return { should: false, reason: "threshold_not_met" };
}
