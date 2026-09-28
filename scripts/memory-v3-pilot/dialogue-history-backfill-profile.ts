import { MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION } from '../../supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.ts';
import {
  MEMORY_V3_DIALOGUE_MAX_MODEL_CALLS_PER_RUN,
  MEMORY_V3_DIALOGUE_MAX_RECONCILER_BYTES,
  MEMORY_V3_DIALOGUE_MAX_SOURCE_MESSAGES,
  MEMORY_V3_DIALOGUE_MAX_STATE_EVIDENCE,
  MEMORY_V3_DIALOGUE_MAX_STATE_ITEMS,
  MEMORY_V3_DIALOGUE_MODEL,
  MEMORY_V3_DIALOGUE_PIPELINE_VERSION,
  MEMORY_V3_DIALOGUE_RECONCILER_VERSION,
  MEMORY_V3_DIALOGUE_RESERVED_INPUT_TOKENS_PER_CALL,
  MEMORY_V3_DIALOGUE_SCHEMA_VERSION,
} from '../../supabase/functions/_shared/memoryV3/dialogueContract.ts';
import { HISTORY_BACKFILL_MODEL_ROUTE } from './history-backfill-provider-profile.ts';

export const DIALOGUE_HISTORY_BACKFILL_PROFILE_ID = 'memory-v3-dialogue-history-backfill-v1' as const;
export const DIALOGUE_HISTORY_BACKFILL_MAX_EXTRACTOR_BYTES = 40_000 as const;
export const DIALOGUE_HISTORY_BACKFILL_MAX_OUTPUT_TOKENS_PER_CALL = 4_096 as const;

export interface DialogueHistoryBackfillProfile {
  profileId: typeof DIALOGUE_HISTORY_BACKFILL_PROFILE_ID;
  schemaVersion: typeof MEMORY_V3_DIALOGUE_SCHEMA_VERSION;
  pipelineVersion: typeof MEMORY_V3_DIALOGUE_PIPELINE_VERSION;
  extractorVersion: typeof MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION;
  reconcilerVersion: typeof MEMORY_V3_DIALOGUE_RECONCILER_VERSION;
  model: typeof MEMORY_V3_DIALOGUE_MODEL;
  modelRoute: typeof HISTORY_BACKFILL_MODEL_ROUTE;
  maxMessagesPerChunk: 60;
  maxExtractorRequestBytes: 40_000;
  maxReconcilerRequestBytes: 80_000;
  reservedInputTokensPerCall: 32_768;
  maxOutputTokensPerCall: 4_096;
  maxStateItems: 100;
  maxStateEvidence: 500;
  maxCallsPerChunk: 2;
  maxActive: 1;
  executeFlag: '--execute-history-backfill-paid-requests';
}

const PROFILE = Object.freeze<DialogueHistoryBackfillProfile>({
  profileId: DIALOGUE_HISTORY_BACKFILL_PROFILE_ID,
  schemaVersion: MEMORY_V3_DIALOGUE_SCHEMA_VERSION,
  pipelineVersion: MEMORY_V3_DIALOGUE_PIPELINE_VERSION,
  extractorVersion: MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
  reconcilerVersion: MEMORY_V3_DIALOGUE_RECONCILER_VERSION,
  model: MEMORY_V3_DIALOGUE_MODEL,
  modelRoute: HISTORY_BACKFILL_MODEL_ROUTE,
  maxMessagesPerChunk: MEMORY_V3_DIALOGUE_MAX_SOURCE_MESSAGES,
  maxExtractorRequestBytes: DIALOGUE_HISTORY_BACKFILL_MAX_EXTRACTOR_BYTES,
  maxReconcilerRequestBytes: MEMORY_V3_DIALOGUE_MAX_RECONCILER_BYTES,
  reservedInputTokensPerCall: MEMORY_V3_DIALOGUE_RESERVED_INPUT_TOKENS_PER_CALL,
  maxOutputTokensPerCall: DIALOGUE_HISTORY_BACKFILL_MAX_OUTPUT_TOKENS_PER_CALL,
  maxStateItems: MEMORY_V3_DIALOGUE_MAX_STATE_ITEMS,
  maxStateEvidence: MEMORY_V3_DIALOGUE_MAX_STATE_EVIDENCE,
  maxCallsPerChunk: MEMORY_V3_DIALOGUE_MAX_MODEL_CALLS_PER_RUN,
  maxActive: 1,
  executeFlag: '--execute-history-backfill-paid-requests',
});

export function getDialogueHistoryBackfillProfile(profileId: unknown): DialogueHistoryBackfillProfile {
  if (typeof profileId !== 'string' || profileId !== DIALOGUE_HISTORY_BACKFILL_PROFILE_ID) {
    const error = new Error('[memory-v3:dialogue-history-backfill-profile] value is invalid');
    error.name = 'MemoryV3DialogueHistoryBackfillProfileError';
    throw error;
  }
  return PROFILE;
}
