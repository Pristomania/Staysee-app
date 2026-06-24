/**
 * PII-free reply recovery diagnostics — service_role insert only.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ReplyRecoveryDiagnostics } from "./replyRecovery.ts";

export interface ReplyRecoveryEventRow {
  requestId?: string | null;
  conversationId?: string | null;
  assistantMessageId?: string | null;
  userId?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  constitutionVersion?: string | null;
  diagnostics: ReplyRecoveryDiagnostics;
}

export function buildRecoveryEventInsert(row: ReplyRecoveryEventRow) {
  const d = row.diagnostics;
  return {
    request_id: row.requestId ?? null,
    conversation_id: row.conversationId ?? null,
    assistant_message_id: row.assistantMessageId ?? null,
    user_id: row.userId ?? null,
    model: row.model ?? null,
    prompt_version: row.promptVersion ?? null,
    constitution_version: row.constitutionVersion ?? null,
    completion_route: d.completionRoute,
    auto_continue_trigger_reason: d.autoContinueTriggerReason,
    stop_not_publishable_reasons: d.stopNotPublishableReasons,
    segment_count: d.segmentCount,
    segment_1_finish_reason: d.segment1?.finishReason ?? null,
    segment_1_content_length: d.segment1?.contentLength ?? null,
    segment_1_publishable: d.segment1?.publishable ?? null,
    segment_1_publishability_fail_reason: d.segment1?.publishabilityFailReasons?.join(",") ?? null,
    segment_2_finish_reason: d.segment2?.finishReason ?? null,
    segment_2_content_length: d.segment2?.contentLength ?? null,
    segment_2_publishable: d.segment2?.publishable ?? null,
    segment_2_publishability_fail_reason: d.segment2?.publishabilityFailReasons?.join(",") ?? null,
    merge_strategy: d.mergeStrategy,
    merged_content_length: d.mergedContentLength,
    duplicate_closure_detected: d.duplicateClosureDetected,
    duplicate_closure_repaired: d.duplicateClosureRepaired,
    duplicate_closure_repair_reason: d.duplicateClosureRepairReason,
    repair_applied: d.repairApplied,
    retry_whole_used: d.retryWholeUsed,
    fail_closed_used: d.failClosedUsed,
  };
}

export async function logReplyRecoveryEvent(
  supabase: SupabaseClient,
  row: ReplyRecoveryEventRow
): Promise<void> {
  const { error } = await supabase
    .from("ai_reply_recovery_events")
    .insert(buildRecoveryEventInsert(row));

  if (error) {
    console.error("[replyRecovery] log event:", error.message);
  }
}
