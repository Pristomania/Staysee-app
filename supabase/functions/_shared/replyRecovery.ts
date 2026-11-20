/**
 * Reply completion routes. A reply the model finished on its own is left as it is. A reply cut by the length limit is continued once
 * (and closed by a short finalize call only if the continuation was itself cut). Nothing is repaired, generated again or removed by
 * phrases (owner's rule, 20.11.2026: no decisions by words; see completeReply.ts).
 */

import {
  isPublishableReply,
  needsAutoContinue,
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
  type MergeStrategy,
} from "./mergeContinuation.ts";
import { isDuplicateContinuation } from "./continuationGuards.ts";

export type CompletionRoute =
  | "normal_publishable"
  | "length_truncation_continue";

export interface SegmentSnapshot {
  finishReason?: string | null;
  contentLength: number;
  publishable: boolean;
  publishabilityFailReasons: string[];
}

/**
 * The fields about repair, a second generation and phrase-based clean-up are kept only so that the shape of the log row does not
 * change; the routes that set them are gone, so they stay empty or false.
 */
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
  const explained = explainPublishability(content, finishReason);
  return {
    finishReason: finishReason ?? null,
    contentLength: content.trim().length,
    publishable: explained.publishable,
    publishabilityFailReasons: explained.reasons,
  };
}

/**
 * Joins a continuation to the text before it. Nothing is removed by phrases (an earlier version dropped paragraphs that followed a
 * goodbye, chosen by lists of words: not allowed). A continuation that only repeats the text is dropped by the caller
 * (isDuplicateContinuation); here the two are joined.
 */
export function mergeLengthContinuation(
  accumulated: string,
  continuation: string
): { content: string; mergeStrategy: MergeStrategy } {
  if (isDuplicateContinuation(accumulated, continuation)) {
    return { content: accumulated, mergeStrategy: "paragraph_sep" };
  }
  const merged = mergeContinuationWithoutOverlap(accumulated, continuation);
  return { content: polishMergedReply(merged.text), mergeStrategy: merged.strategy };
}

/**
 * The route of a reply: only a reply the model was cut in (finish_reason "length") that does not already end on a sentence mark is
 * continued. Everything else, including a reply that stopped by itself without a mark, goes out as it is.
 */
export function classifyInitialRoute(
  content: string,
  finishReason?: string | null
): CompletionRoute {
  if (needsAutoContinue(content, finishReason ?? undefined) && !isPublishableReply(content)) {
    return "length_truncation_continue";
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
 * Length truncation may continue+merge; a reply that stopped by itself is never repaired, merged or generated again.
 */
export async function runReplyRecoveryRoutes(
  input: RunReplyRecoveryRoutesInput
): Promise<RunReplyRecoveryRoutesResult> {
  const {
    baseModelMessages,
    unavailableMessage,
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
  }

  // Finalize is only allowed after a real length continuation that was itself cut; never append a second model call to a segment
  // the model finished on its own.
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

export { needsAutoContinue };
