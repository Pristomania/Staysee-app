import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import { prepareAiDisplayText } from './aiMessageFormat.tsx';

// The rule (owner's decision, 20.11.2026): the words of a reply are never decided by code. The browser used to carry a copy of the
// server's word filter (display and saved messages); it is gone, and a reply is shown as the model wrote it.

const REPLIES = [
  'Чёрт, я сбилась. Давай заново.',
  'Блин, я перепутала даты.',
  'Чёрт!',
  'Черты характера у тебя сильные.',
  'Это важно.\n\nЧертовски устала, да?',
];

describe('the text shown to the person keeps every word', () => {
  for (const reply of REPLIES) {
    it(`keeps «${reply.replace(/\n/g, ' / ')}»`, () => {
      assert.equal(prepareAiDisplayText(reply), reply);
    });
  }

  it('does not bring back the browser copy of the word filter', () => {
    assert.equal(existsSync(new URL('./languageGuard.ts', import.meta.url)), false);
  });
});
