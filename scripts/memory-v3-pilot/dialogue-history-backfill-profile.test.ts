import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION } from '../../supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.ts';
import {
  DIALOGUE_HISTORY_BACKFILL_PROFILE_ID,
  getDialogueHistoryBackfillProfile,
} from './dialogue-history-backfill-profile.ts';

describe('dialogue history backfill profile', () => {
  it('owns one exact deeply frozen dialogue profile', () => {
    const first = getDialogueHistoryBackfillProfile('memory-v3-dialogue-history-backfill-v1');
    const second = getDialogueHistoryBackfillProfile(DIALOGUE_HISTORY_BACKFILL_PROFILE_ID);
    assert.equal(first, second);
    assert.equal(first.profileId, 'memory-v3-dialogue-history-backfill-v1');
    assert.equal(first.extractorVersion, MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.modelRoute), true);
  });

  it('rejects every non-canonical direct id without importing lifecycle profile', () => {
    for (const value of [null, {}, new String(DIALOGUE_HISTORY_BACKFILL_PROFILE_ID), [], Symbol('profile'), 'unknown']) {
      assert.throws(() => getDialogueHistoryBackfillProfile(value));
    }
    const source = readFileSync(new URL('./dialogue-history-backfill-profile.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /lifecycle-history-backfill-profile/);
  });
});
