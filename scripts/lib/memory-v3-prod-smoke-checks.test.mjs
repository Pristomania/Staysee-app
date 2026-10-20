import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DELTA_WINDOW_MAX,
  checkDialogueRuns,
  checkLifecycleRuns,
  checkMemoryItems,
} from './memory-v3-prod-smoke-checks.mjs';

const NOW = Date.parse('2026-10-18T16:00:00Z');
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

function run(overrides = {}) {
  return {
    status: 'succeeded',
    diagnostic_code: null,
    message_count: 6,
    extractor_prompt_tokens: 2500,
    created_at: minutesAgo(10),
    ...overrides,
  };
}

// A healthy conversation: the first run reads what exists, later runs read only a small window.
const healthy = () => [
  run({ message_count: 2, extractor_prompt_tokens: 1800, created_at: minutesAgo(30) }),
  run({ message_count: 7, extractor_prompt_tokens: 2400, created_at: minutesAgo(20) }),
  run({ message_count: 8, extractor_prompt_tokens: 2500, created_at: minutesAgo(10) }),
];

describe('dialogue memory runs in production', () => {
  it('passes a healthy conversation and reports token use', () => {
    const result = checkDialogueRuns(healthy(), { totalMessages: 28, now: NOW });
    assert.deepEqual(result.problems, []);
    assert.match(result.notes.join('\n'), /3 runs/);
  });

  it('reports how long runs take, so overlapping runs can be told from slow ones', () => {
    const at = (seconds) => new Date(NOW - 600_000 + seconds * 1000).toISOString();
    const timed = [
      run({ message_count: 2, created_at: at(0), completed_at: at(8) }),
      run({ message_count: 6, created_at: at(30), completed_at: at(50) }),
      run({ message_count: 7, created_at: at(60), completed_at: at(64) }),
    ];
    const notes = checkDialogueRuns(timed, { totalMessages: 28, now: NOW }).notes.join('\n');
    assert.match(notes, /run time.*median 8s.*longest 20s/);
  });

  it('fails when no run was recorded at all', () => {
    const result = checkDialogueRuns([], { totalMessages: 28, now: NOW });
    assert.match(result.problems.join('\n'), /no dialogue memory runs/);
  });

  it('fails on any failed run and names the cause', () => {
    const runs = [...healthy(), run({ status: 'failed', diagnostic_code: 'state_write_failed', created_at: minutesAgo(5) })];
    const result = checkDialogueRuns(runs, { totalMessages: 28, now: NOW });
    assert.match(result.problems.join('\n'), /1 failed.*state_write_failed/);
  });

  it('shows the transport detail of a failed run, so a provider problem can be told from a timeout', () => {
    const runs = [...healthy(), run({ status: 'failed', diagnostic_code: 'extractor_transport_failed', transport_detail: 'provider_http_4xx', created_at: minutesAgo(5) })];
    const result = checkDialogueRuns(runs, { totalMessages: 28, now: NOW });
    assert.match(result.problems.join('\n'), /extractor_transport_failed \(provider_http_4xx\)/);
  });

  it('does not fail on a state conflict that a later run recovered from, but notes it', () => {
    const runs = [
      run({ message_count: 2, created_at: minutesAgo(30) }),
      run({ status: 'failed', diagnostic_code: 'state_conflict', created_at: minutesAgo(20) }),
      run({ message_count: 7, created_at: minutesAgo(19) }),
      run({ message_count: 8, created_at: minutesAgo(10) }),
    ];
    const result = checkDialogueRuns(runs, { totalMessages: 28, now: NOW });
    assert.deepEqual(result.problems, []);
    assert.match(result.notes.join('\n'), /1 state conflict.*retried/);
  });

  it('still fails on a state conflict nothing recovered from', () => {
    const runs = [
      run({ message_count: 2, created_at: minutesAgo(30) }),
      run({ message_count: 7, created_at: minutesAgo(20) }),
      run({ status: 'failed', diagnostic_code: 'state_conflict', created_at: minutesAgo(5) }),
    ];
    const result = checkDialogueRuns(runs, { totalMessages: 28, now: NOW });
    assert.match(result.problems.join('\n'), /1 failed.*state_conflict/);
  });

  it('fails on a run stuck in reserved, but not on one that just started', () => {
    const stuck = checkDialogueRuns([...healthy(), run({ status: 'reserved', created_at: minutesAgo(5) })], { totalMessages: 28, now: NOW });
    assert.match(stuck.problems.join('\n'), /stuck/);
    const fresh = checkDialogueRuns([...healthy(), run({ status: 'reserved', created_at: new Date(NOW - 20_000).toISOString() })], { totalMessages: 28, now: NOW });
    assert.deepEqual(fresh.problems, []);
  });

  it('fails when a later run sent the whole conversation instead of a small window (delta windowing not working)', () => {
    const runs = [
      run({ message_count: 2, created_at: minutesAgo(30) }),
      run({ message_count: 20, created_at: minutesAgo(20) }),
      run({ message_count: 28, created_at: minutesAgo(10) }),
    ];
    const result = checkDialogueRuns(runs, { totalMessages: 28, now: NOW });
    assert.match(result.problems.join('\n'), /delta windowing/);
  });

  it('allows the very first run to read the whole (short) conversation', () => {
    const runs = [run({ message_count: 24, created_at: minutesAgo(30) }), run({ message_count: 6, created_at: minutesAgo(10) })];
    assert.deepEqual(checkDialogueRuns(runs, { totalMessages: 28, now: NOW }).problems, []);
  });

  it('does not judge the window size on a short conversation', () => {
    const runs = [run({ message_count: 2, created_at: minutesAgo(30) }), run({ message_count: DELTA_WINDOW_MAX + 1, created_at: minutesAgo(10) })];
    assert.deepEqual(checkDialogueRuns(runs, { totalMessages: 8, now: NOW }).problems, []);
  });

  it('needs at least two succeeded runs, otherwise it cannot tell whether windowing works', () => {
    const result = checkDialogueRuns([run()], { totalMessages: 28, now: NOW });
    assert.match(result.problems.join('\n'), /at least 2 succeeded/);
  });

  it('judges runs in the order they were created, not the order they arrive', () => {
    const runs = healthy().reverse();
    assert.deepEqual(checkDialogueRuns(runs, { totalMessages: 28, now: NOW }).problems, []);
  });
});

describe('cross-conversation (lifecycle) memory runs in production', () => {
  it('passes when at least one run succeeded and none failed', () => {
    assert.deepEqual(checkLifecycleRuns([run(), run()], { now: NOW }).problems, []);
  });

  it('fails when nothing ran, or nothing succeeded', () => {
    assert.match(checkLifecycleRuns([], { now: NOW }).problems.join('\n'), /no lifecycle memory runs/);
    assert.match(checkLifecycleRuns([run({ status: 'reserved', created_at: minutesAgo(0.1) })], { now: NOW }).problems.join('\n'), /no succeeded/);
  });

  it('does not fail on a state conflict that a later run recovered from', () => {
    const runs = [
      run({ status: 'failed', diagnostic_code: 'state_conflict', created_at: minutesAgo(20) }),
      run({ created_at: minutesAgo(19) }),
    ];
    const result = checkLifecycleRuns(runs, { now: NOW });
    assert.deepEqual(result.problems, []);
    assert.match(result.notes.join('\n'), /1 state conflict.*retried/);
  });

  it('fails on a failed run', () => {
    const result = checkLifecycleRuns([run(), run({ status: 'failed', diagnostic_code: 'reservation_failed' })], { now: NOW });
    assert.match(result.problems.join('\n'), /1 failed.*reservation_failed/);
  });
});

describe('memory items extracted in production', () => {
  it('passes when the conversation produced at least one item and lists them', () => {
    const result = checkMemoryItems([{ kind: 'event', status: 'active', claim: 'Есть кошка по имени Муся' }]);
    assert.deepEqual(result.problems, []);
    assert.match(result.notes.join('\n'), /Муся/);
  });

  it('fails when nothing was extracted from a conversation full of personal facts', () => {
    assert.match(checkMemoryItems([]).problems.join('\n'), /no memory items/);
  });
});
