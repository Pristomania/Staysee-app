/**
 * Safe reply-completion diagnostics — no full user/assistant text (PII).
 */

export interface ReplyCompletionLogMeta {
  finishReason?: string;
  autoContinueSegments: number;
  finalizeAttempts: number;
  lengthBeforeMerge: number;
  lengthAfterMerge: number;
  wasAutoContinued: boolean;
  wasFinalizeUsed: boolean;
  publishable: boolean;
  lastMergeStrategy?: string;
  overlapWords?: number;
  usedMergeFallback?: boolean;
}

export function logReplyCompletion(meta: ReplyCompletionLogMeta): void {
  const parts = [
    "[staysee-chat] reply_completion",
    `finish_reason=${meta.finishReason ?? "unknown"}`,
    `auto_continue_segments=${meta.autoContinueSegments}`,
    `finalize_attempts=${meta.finalizeAttempts}`,
    `length_before_merge=${meta.lengthBeforeMerge}`,
    `length_after_merge=${meta.lengthAfterMerge}`,
    `was_auto_continued=${meta.wasAutoContinued}`,
    `was_finalize_used=${meta.wasFinalizeUsed}`,
    `publishable=${meta.publishable}`,
  ];
  if (meta.lastMergeStrategy) {
    parts.push(`merge_strategy=${meta.lastMergeStrategy}`);
  }
  if (meta.overlapWords != null && meta.overlapWords > 0) {
    parts.push(`overlap_words=${meta.overlapWords}`);
  }
  if (meta.usedMergeFallback) {
    parts.push("merge_fallback=true");
  }
  console.log(parts.join(" "));
}
