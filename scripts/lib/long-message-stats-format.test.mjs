import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OVER_LIMIT_PEOPLE_SIGNAL, formatLongMessageStats, verdictFor } from './long-message-stats-format.mjs';

const stats = (overrides = {}) => ({
  days: 30,
  user_messages: 823,
  over_1000: 10,
  over_4000: 1,
  over_8000: 0,
  max_length: 7260,
  long_message_events: 3,
  long_message_users: 2,
  over_limit_events: 0,
  over_limit_users: 0,
  over_limit_max: 0,
  summaries_made: 1,
  ...overrides,
});

describe('long message report', () => {
  it('says nothing is wrong while nobody hits the limit and nothing is near it', () => {
    assert.match(verdictFor(stats()), /пока никому не мешает/);
  });

  it('asks to discuss a longer limit once several different people hit it', () => {
    const text = verdictFor(stats({ over_limit_events: 5, over_limit_users: OVER_LIMIT_PEOPLE_SIGNAL, over_limit_max: 15000 }));
    assert.match(text, /обсудить увеличение/);
  });

  it('treats one or two people as single cases to watch', () => {
    assert.match(verdictFor(stats({ over_limit_events: 2, over_limit_users: 1, over_limit_max: 11000 })), /единичные/i);
    assert.match(verdictFor(stats({ over_8000: 2 })), /единичные/i);
  });

  it('shows every number of the report with the period, in plain words', () => {
    const text = formatLongMessageStats(stats({ over_limit_events: 2, over_limit_users: 1, over_limit_max: 11000 }));
    assert.match(text, /за 30 дн/);
    assert.match(text, /823/);
    assert.match(text, /длиннее 4\u00a0000: 1/);
    assert.match(text, /самое длинное: 7\u00a0260/);
    assert.match(text, /3 раза, 2 чел/);
    assert.match(text, /упёрлись в предел[^\n]*2 раза, 1 чел[^\n]*11\u00a0000/i);
    assert.match(text, /краткие версии[^\n]*1/i);
  });

  it('copes with a report that has no data at all', () => {
    const text = formatLongMessageStats(stats({ user_messages: 0, over_1000: 0, over_4000: 0, max_length: 0, long_message_events: 0, long_message_users: 0, summaries_made: 0 }));
    assert.match(text, /пока никому не мешает/);
  });
});
