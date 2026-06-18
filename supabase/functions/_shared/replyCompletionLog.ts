/**
 * Safe reply-completion diagnostics — no full user/assistant text (PII).
 */

export interface SegmentMergeLogMeta {
  segmentIndex: number;
  segmentKind: "auto_continue" | "finalize";
  finishReason?: string;
  mergeStrategy?: string;
  beforeLen: number;
  continuationLen: number;
  afterLen: number;
  discardedDuplicate: boolean;
}

export interface ReplyCompletionLogMeta {
  finishReason?: string;
  /** @deprecated use autoContinueCount */
  autoContinueSegments: number;
  finalizeAttempts: number;
  autoContinueCount: number;
  finalizeCount: number;
  discardedDuplicateCount: number;
  mergeStrategies: string[];
  lengthBeforeMerge: number;
  lengthAfterMerge: number;
  wasAutoContinued: boolean;
  wasFinalizeUsed: boolean;
  publishable: boolean;
  lastMergeStrategy?: string;
  overlapWords?: number;
  usedMergeFallback?: boolean;
}

export function logSegmentMerge(meta: SegmentMergeLogMeta): void {
  const parts = [
    "[staysee-chat] continuation_merge",
    `segment_index=${meta.segmentIndex}`,
    `segment_kind=${meta.segmentKind}`,
    `finish_reason=${meta.finishReason ?? "unknown"}`,
    `merge_strategy=${meta.mergeStrategy ?? "none"}`,
    `before_len=${meta.beforeLen}`,
    `continuation_len=${meta.continuationLen}`,
    `after_len=${meta.afterLen}`,
    `discarded_duplicate=${meta.discardedDuplicate}`,
  ];
  if (meta.discardedDuplicate) {
    parts.push("continuation_discarded_duplicate=true");
  }
  console.log(parts.join(" "));
}

export function logReplyCompletion(meta: ReplyCompletionLogMeta): void {
  const parts = [
    "[staysee-chat] reply_completion",
    `finish_reason=${meta.finishReason ?? "unknown"}`,
    `auto_continue_count=${meta.autoContinueCount}`,
    `finalize_count=${meta.finalizeCount}`,
    `auto_continue_segments=${meta.autoContinueSegments}`,
    `finalize_attempts=${meta.finalizeAttempts}`,
    `discarded_duplicate_count=${meta.discardedDuplicateCount}`,
    `merge_strategies=${meta.mergeStrategies.join(",") || "none"}`,
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
