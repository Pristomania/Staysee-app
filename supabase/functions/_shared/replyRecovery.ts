/**
 * Reply completion routes: length continuation vs stop-not-publishable repair/retry.
 */

import {
  ensurePublishableReply,
  isPublishableReply,
  needsAutoContinue,
  needsStopNotPublishableRepair,
  MAX_AUTO_CONTINUE_SEGMENTS,
  MAX_FINALIZE_ATTEMPTS,
  AUTO_CONTINUE_USER_PROMPT,
  FINALIZE_USER_PROMPT,
  shouldRunFinalize,
} from "./completeReply.ts";
import { explainPublishability } from "./replyPublishability.ts";
import {
  mergeContinuationWithoutOverlap,
  polishMergedReply,
  stripOrphanContinueMarkers,
  type MergeStrategy,
} from "./mergeContinuation.ts";
import { isDuplicateContinuation } from "./continuationGuards.ts";

export type CompletionRoute =
  | "normal_publishable"
  | "length_truncation_continue"
  | "stop_not_publishable_repair"
  | "stop_not_publishable_retry_whole"
  | "stop_not_publishable_fail_closed";

export interface SegmentSnapshot {
  finishReason?: string | null;
  contentLength: number;
  publishable: boolean;
  publishabilityFailReasons: string[];
}

export interface ReplyRecoveryDiagnostics {
  completionRoute: CompletionRoute;
  autoContinueTriggerReason: "finish_reason_length" | null;
  stopNotPublishableReasons: string[];
  segmentCount: number;
  segment1: SegmentSnapshot | null;
  segment2: SegmentSnapshot | null;
  mergeStrategy: string | null;
  mergedContentLength: number | null;
  duplicateClosureDetected: boolean;
  duplicateClosureRepaired: boolean;
  duplicateClosureRepairReason: string | null;
  repairApplied: boolean;
  retryWholeUsed: boolean;
  failClosedUsed: boolean;
}

export function createEmptyRecoveryDiagnostics(): ReplyRecoveryDiagnostics {
  return {
    completionRoute: "normal_publishable",
    autoContinueTriggerReason: null,
    stopNotPublishableReasons: [],
    segmentCount: 1,
    segment1: null,
    segment2: null,
    mergeStrategy: null,
    mergedContentLength: null,
    duplicateClosureDetected: false,
    duplicateClosureRepaired: false,
    duplicateClosureRepairReason: null,
    repairApplied: false,
    retryWholeUsed: false,
    failClosedUsed: false,
  };
}

export function snapshotSegment(
  content: string,
  finishReason?: string | null
): SegmentSnapshot {
  const explained = explainPublishability(content);
  return {
    finishReason: finishReason ?? null,
    contentLength: content.trim().length,
    publishable: explained.publishable,
    publishabilityFailReasons: explained.reasons,
  };
}

/** Local structural repair only — no new model content. */
export function applyLocalStructuralRepair(content: string): string {
  let t = content.trim();
  if (!t) return t;
  t = stripOrphanContinueMarkers(t);
  t = t.replace(/([.!?…])\1+/gu, "$1");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]+\n/g, "\n");
  return ensurePublishableReply(t);
}

const CLOSURE_LINE_RE =
  /^(?:Спи[,.]?|Ты молодец[.!]?|Отдыхай[.!]?|Пусть будет покой[.!]?)/iu;

const RECAP_OPENING_RE =
  /^Ты сегодня прошла|^Ты всё выключила|^Ты выгнала|^Из этого места|^Ты только начала этот путь/iu;

export function detectDuplicateClosure(text: string): boolean {
  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length < 2) return false;

  let closureIdx = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (CLOSURE_LINE_RE.test(p) || /заслужила этот покой/i.test(p)) {
      closureIdx = i;
      break;
    }
  }
  if (closureIdx < 0) return false;

  for (let j = closureIdx + 1; j < paragraphs.length; j++) {
    const next = paragraphs[j];
    if (RECAP_OPENING_RE.test(next) || CLOSURE_LINE_RE.test(next)) {
      return true;
    }
  }
  return false;
}

/** Route A only — remove recap paragraph(s) after an established closure. */
export function repairDuplicateClosure(text: string): {
  text: string;
  repaired: boolean;
  reason: string | null;
} {
  if (!detectDuplicateClosure(text)) {
    return { text, repaired: false, reason: null };
  }

  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  let closureIdx = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (CLOSURE_LINE_RE.test(p) || /заслужила этот покой/i.test(p)) {
      closureIdx = i;
      break;
    }
  }
  if (closureIdx < 0) {
    return { text, repaired: false, reason: null };
  }

  const kept = paragraphs.slice(0, closureIdx + 1);
  const dropped = paragraphs.slice(closureIdx + 1).filter(
    (p) => RECAP_OPENING_RE.test(p) || CLOSURE_LINE_RE.test(p)
  );

  if (dropped.length === 0) {
    return { text, repaired: false, reason: null };
  }

  const repairedText = polishMergedReply(kept.join("\n\n"));
  return {
    text: repairedText,
    repaired: true,
    reason: "dropped_recap_after_closure",
  };
}

export function mergeLengthContinuation(
  accumulated: string,
  continuation: string
): { content: string; mergeStrategy: MergeStrategy; duplicateClosureDetected: boolean; duplicateClosureRepaired: boolean; duplicateClosureRepairReason: string | null } {
  if (isDuplicateContinuation(accumulated, continuation)) {
    const guard = repairDuplicateClosure(accumulated);
    return {
      content: guard.text,
      mergeStrategy: "paragraph_sep",
      duplicateClosureDetected: guard.repaired,
      duplicateClosureRepaired: guard.repaired,
      duplicateClosureRepairReason: guard.reason,
    };
  }

  const merged = mergeContinuationWithoutOverlap(accumulated, continuation);
  let content = polishMergedReply(merged.text);
  const dup = repairDuplicateClosure(content);
  return {
    content: dup.text,
    mergeStrategy: merged.strategy,
    duplicateClosureDetected: detectDuplicateClosure(content),
    duplicateClosureRepaired: dup.repaired,
    duplicateClosureRepairReason: dup.reason,
  };
}

export function classifyInitialRoute(
  content: string,
  finishReason?: string | null
): CompletionRoute {
  if (isPublishableReply(content)) return "normal_publishable";
  if (needsAutoContinue(content, finishReason)) return "length_truncation_continue";
  if (needsStopNotPublishableRepair(content, finishReason)) {
    return "stop_not_publishable_repair";
  }
  return "normal_publishable";
}

export type RecoveryChatMessage = { role: "user" | "assistant"; content: string };
export type RecoveryModelCallKind = "auto_continue" | "retry_whole" | "finalize";

export interface RecoveryModelCallResult {
  content: string;
  finishReason?: string | null;
}

export type RecoveryModelCall = (
  messages: RecoveryChatMessage[],
  kind: RecoveryModelCallKind
) => Promise<RecoveryModelCallResult>;

export interface SegmentMergeHookMeta {
  segmentIndex: number;
  segmentKind: "auto_continue" | "finalize";
  finishReason?: string | null;
  mergeStrategy?: string;
  beforeLen: number;
  continuationLen: number;
  afterLen: number;
  discardedDuplicate: boolean;
}

export interface RunReplyRecoveryRoutesInput {
  firstSegment: { content: string; finishReason?: string | null };
  baseModelMessages: RecoveryChatMessage[];
  unavailableMessage: string;
  /** Used only for stop+not_publishable fail-closed; defaults to unavailableMessage */
  replyNotRecoveredMessage?: string;
  callModel: RecoveryModelCall;
  onSegmentMerge?: (meta: SegmentMergeHookMeta) => void;
}

export interface RunReplyRecoveryRoutesResult {
  content: string;
  finishReason?: string | null;
  diagnostics: ReplyRecoveryDiagnostics;
  wasAutoContinued: boolean;
  wasFinalizeUsed: boolean;
  wasTruncated: boolean;
  autoContinueCount: number;
  finalizeCount: number;
  mergeStrategies: string[];
  discardedDuplicateCount: number;
  lengthBeforeMerge: number;
  lengthAfterMerge: number;
  lastMergeStrategy?: MergeStrategy;
  lastOverlapWords: number;
}

/**
 * Orchestrates reply recovery routes after the first provider segment.
 * Length truncation may continue+merge; stop+not_publishable uses repair/retry/fail — never merge.
 */
export async function runReplyRecoveryRoutes(
  input: RunReplyRecoveryRoutesInput
): Promise<RunReplyRecoveryRoutesResult> {
  const {
    baseModelMessages,
    unavailableMessage,
    replyNotRecoveredMessage = unavailableMessage,
    callModel,
    onSegmentMerge,
  } = input;

  let content = input.firstSegment.content.trim();
  let finishReason = input.firstSegment.finishReason ?? null;

  let autoContinueCount = 0;
  let finalizeCount = 0;
  let wasAutoContinued = false;
  let wasFinalizeUsed = false;
  let wasTruncated = finishReason === "length";
  let lengthBeforeMerge = 0;
  let lengthAfterMerge = content.length;
  let lastMergeStrategy: MergeStrategy | undefined;
  let lastOverlapWords = 0;
  let discardedDuplicateCount = 0;
  const mergeStrategies: string[] = [];
  let segmentIndex = 0;

  const firstSegmentContent = content;
  const recoveryDiagnostics = createEmptyRecoveryDiagnostics();
  recoveryDiagnostics.segment1 = snapshotSegment(firstSegmentContent, finishReason);

  const initialRoute = classifyInitialRoute(firstSegmentContent, finishReason);
  recoveryDiagnostics.completionRoute = initialRoute;

  const applyContinuationMerge = (accumulated: string, continuation: string) => {
    lengthBeforeMerge = accumulated.length;
    const merged = mergeContinuationWithoutOverlap(accumulated, continuation);
    lengthAfterMerge = merged.text.length;
    lastMergeStrategy = merged.strategy;
    lastOverlapWords = merged.overlapWords;
    mergeStrategies.push(merged.strategy);
    return polishMergedReply(merged.text);
  };

  if (initialRoute === "length_truncation_continue") {
    recoveryDiagnostics.autoContinueTriggerReason = "finish_reason_length";

    while (
      content &&
      autoContinueCount < MAX_AUTO_CONTINUE_SEGMENTS &&
      needsAutoContinue(content, finishReason ?? undefined)
    ) {
      const accumulated = content;
      const retry = await callModel(
        [
          ...baseModelMessages,
          { role: "assistant", content: accumulated },
          { role: "user", content: AUTO_CONTINUE_USER_PROMPT },
        ],
        "auto_continue"
      );
      segmentIndex++;
      autoContinueCount++;
      wasAutoContinued = true;
      recoveryDiagnostics.segmentCount = 2;
      recoveryDiagnostics.segment2 = snapshotSegment(
        retry.content?.trim() ?? "",
        retry.finishReason
      );
      if (retry.finishReason === "length") wasTruncated = true;

      const continuation = retry.content?.trim() ?? "";
      if (!continuation || continuation === unavailableMessage) {
        break;
      }

      if (isDuplicateContinuation(accumulated, continuation)) {
        discardedDuplicateCount++;
        onSegmentMerge?.({
          segmentIndex,
          segmentKind: "auto_continue",
          finishReason: retry.finishReason,
          beforeLen: accumulated.length,
          continuationLen: continuation.length,
          afterLen: accumulated.length,
          discardedDuplicate: true,
        });
        break;
      }

      lengthBeforeMerge = accumulated.length;
      const merged = mergeLengthContinuation(accumulated, continuation);
      lengthAfterMerge = merged.content.length;
      lastMergeStrategy = merged.mergeStrategy;
      lastOverlapWords = 0;
      mergeStrategies.push(merged.mergeStrategy);
      if (merged.duplicateClosureDetected) {
        recoveryDiagnostics.duplicateClosureDetected = true;
      }
      if (merged.duplicateClosureRepaired) {
        recoveryDiagnostics.duplicateClosureRepaired = true;
        recoveryDiagnostics.duplicateClosureRepairReason =
          merged.duplicateClosureRepairReason;
      }
      recoveryDiagnostics.mergeStrategy = merged.mergeStrategy;
      recoveryDiagnostics.mergedContentLength = merged.content.length;

      onSegmentMerge?.({
        segmentIndex,
        segmentKind: "auto_continue",
        finishReason: retry.finishReason,
        mergeStrategy: lastMergeStrategy,
        beforeLen: lengthBeforeMerge,
        continuationLen: continuation.length,
        afterLen: lengthAfterMerge,
        discardedDuplicate: false,
      });

      content = merged.content;
      finishReason = retry.finishReason ?? finishReason;
    }
  } else if (initialRoute === "stop_not_publishable_repair") {
    recoveryDiagnostics.stopNotPublishableReasons =
      recoveryDiagnostics.segment1?.publishabilityFailReasons ?? [];

    const repaired = applyLocalStructuralRepair(firstSegmentContent);
    if (isPublishableReply(repaired)) {
      content = repaired;
      recoveryDiagnostics.repairApplied = true;
      recoveryDiagnostics.mergedContentLength = repaired.length;
    } else {
      // Retry whole: same base context as initial request — no rejected segment1.
      const retryWhole = await callModel(baseModelMessages, "retry_whole");
      recoveryDiagnostics.segmentCount = 2;
      recoveryDiagnostics.segment2 = snapshotSegment(
        retryWhole.content?.trim() ?? "",
        retryWhole.finishReason
      );

      const retryBody = retryWhole.content?.trim() ?? "";
      if (
        retryBody &&
        retryBody !== unavailableMessage &&
        retryBody !== replyNotRecoveredMessage &&
        isPublishableReply(retryBody)
      ) {
        content = retryBody;
        finishReason = retryWhole.finishReason ?? finishReason;
        recoveryDiagnostics.completionRoute = "stop_not_publishable_retry_whole";
        recoveryDiagnostics.retryWholeUsed = true;
        recoveryDiagnostics.mergedContentLength = retryBody.length;
        wasTruncated = retryWhole.finishReason === "length";
      } else {
        content = replyNotRecoveredMessage;
        recoveryDiagnostics.completionRoute = "stop_not_publishable_fail_closed";
        recoveryDiagnostics.failClosedUsed = true;
      }
    }
  }

  // Finalize is only allowed after real length-continuation. For stop+not_publishable,
  // use repair/retry/fail-closed; never append a second model call to a stopped segment.
  while (
    content &&
    wasAutoContinued &&
    finalizeCount < MAX_FINALIZE_ATTEMPTS &&
    shouldRunFinalize(content, wasAutoContinued)
  ) {
    const accumulated = content;
    const retry = await callModel(
      [
        ...baseModelMessages,
        { role: "assistant", content: accumulated },
        { role: "user", content: FINALIZE_USER_PROMPT },
      ],
      "finalize"
    );
    segmentIndex++;
    finalizeCount++;
    wasFinalizeUsed = true;
    if (retry.finishReason === "length") wasTruncated = true;

    const continuation = retry.content?.trim() ?? "";
    if (!continuation || continuation === unavailableMessage) {
      break;
    }

    if (isDuplicateContinuation(accumulated, continuation)) {
      discardedDuplicateCount++;
      onSegmentMerge?.({
        segmentIndex,
        segmentKind: "finalize",
        finishReason: retry.finishReason,
        beforeLen: accumulated.length,
        continuationLen: continuation.length,
        afterLen: accumulated.length,
        discardedDuplicate: true,
      });
      break;
    }

    const mergedContent = applyContinuationMerge(accumulated, continuation);
    onSegmentMerge?.({
      segmentIndex,
      segmentKind: "finalize",
      finishReason: retry.finishReason,
      mergeStrategy: lastMergeStrategy,
      beforeLen: lengthBeforeMerge,
      continuationLen: continuation.length,
      afterLen: lengthAfterMerge,
      discardedDuplicate: false,
    });

    content = mergedContent;
    finishReason = retry.finishReason ?? finishReason;
  }

  return {
    content,
    finishReason,
    diagnostics: recoveryDiagnostics,
    wasAutoContinued,
    wasFinalizeUsed,
    wasTruncated,
    autoContinueCount,
    finalizeCount,
    mergeStrategies,
    discardedDuplicateCount,
    lengthBeforeMerge,
    lengthAfterMerge,
    lastMergeStrategy,
    lastOverlapWords,
  };
}

export { needsAutoContinue, needsStopNotPublishableRepair };
