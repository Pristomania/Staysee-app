/**
 * What counts as "Memory V3 works in production" for scripts/memory-v3-prod-smoke.mjs.
 * Pure functions over rows read from the database, so the rules themselves are
 * tested offline (memory-v3-prod-smoke-checks.test.mjs) and the live script stays thin.
 *
 * Each check returns { problems: string[], notes: string[] }: problems fail the
 * smoke test; notes are shown for a human.
 */

// After its first run, a conversation's dialogue memory should send the model a small
// window (about 5 messages of context plus the new ones), never the whole conversation.
// A run that lags behind a few exchanges still fits well inside this bound.
export const DELTA_WINDOW_MAX = 14;
// Only judge the window once the conversation is clearly longer than that bound.
export const DELTA_MIN_TOTAL = 20;
// A run still "reserved" after this long was started and never finished.
export const STUCK_AFTER_MS = 120_000;

const byCreatedAt = (left, right) => Date.parse(left.created_at) - Date.parse(right.created_at);

// A state_conflict means two runs wrote the same memory state at once; the app reruns once and
// the monitor does not count it as a failure. It is only a problem when no run succeeded after it.
function isRecoveredConflict(run, runs) {
  return run.diagnostic_code === 'state_conflict' &&
    runs.some((other) => other.status === 'succeeded' && byCreatedAt(other, run) > 0);
}

function commonRunProblems(label, runs, now) {
  const problems = [];
  const notes = [];
  const recovered = runs.filter((run) => run.status === 'failed' && isRecoveredConflict(run, runs));
  if (recovered.length > 0) {
    notes.push(`${recovered.length} state conflict(s) in ${label} runs, retried and recovered`);
  }
  const failed = runs.filter((run) => run.status === 'failed' && !recovered.includes(run));
  if (failed.length > 0) {
    const codes = [...new Set(failed.map((run) => {
      const code = run.diagnostic_code ?? 'no code';
      return run.transport_detail ? `${code} (${run.transport_detail})` : code;
    }))].join(', ');
    problems.push(`${failed.length} failed ${label} run(s): ${codes}`);
  }
  const stuck = runs.filter((run) => run.status === 'reserved' && now - Date.parse(run.created_at) > STUCK_AFTER_MS);
  if (stuck.length > 0) {
    problems.push(`${stuck.length} ${label} run(s) stuck in "reserved" for over ${STUCK_AFTER_MS / 1000}s`);
  }
  return { problems, notes };
}

export function checkDialogueRuns(rows, { totalMessages, now = Date.now() }) {
  if (rows.length === 0) {
    return { problems: ['no dialogue memory runs were recorded for the test conversation'], notes: [] };
  }
  const runs = [...rows].sort(byCreatedAt);
  const { problems, notes } = commonRunProblems('dialogue', runs, now);

  const succeeded = runs.filter((run) => run.status === 'succeeded');
  if (succeeded.length < 2) {
    problems.push(`need at least 2 succeeded dialogue runs to judge windowing, got ${succeeded.length}`);
  } else if (totalMessages >= DELTA_MIN_TOTAL) {
    // The first run is exempt: it reads whatever existed when it started.
    const tooBig = succeeded.slice(1).filter((run) => run.message_count > DELTA_WINDOW_MAX);
    if (tooBig.length > 0) {
      const sizes = tooBig.map((run) => run.message_count).join(', ');
      problems.push(
        `delta windowing is not working: ${tooBig.length} later run(s) sent ${sizes} messages ` +
          `(limit ${DELTA_WINDOW_MAX}) from a ${totalMessages}-message conversation`,
      );
    }
  }

  const tokens = succeeded.map((run) => run.extractor_prompt_tokens).filter((value) => Number.isFinite(value));
  const sent = succeeded.map((run) => run.message_count).join(' -> ');
  notes.push(
    `${runs.length} runs (${succeeded.length} succeeded); messages sent per run: ${sent || 'n/a'}` +
      (tokens.length > 0 ? `; extractor prompt tokens first -> last: ${tokens[0]} -> ${tokens[tokens.length - 1]}` : ''),
  );
  // Overlapping runs of one conversation (a new message arriving before the previous
  // run finished) are the usual cause of state_conflict; the run time shows how likely that is.
  const seconds = runs
    .filter((run) => run.completed_at)
    .map((run) => (Date.parse(run.completed_at) - Date.parse(run.created_at)) / 1000)
    .sort((left, right) => left - right);
  if (seconds.length > 0) {
    const median = seconds[Math.floor((seconds.length - 1) / 2)];
    notes.push(`run time: median ${Math.round(median)}s, longest ${Math.round(seconds[seconds.length - 1])}s`);
  }
  return { problems, notes };
}

export function checkLifecycleRuns(rows, { now = Date.now() }) {
  if (rows.length === 0) {
    return { problems: ['no lifecycle memory runs were recorded for the test conversation'], notes: [] };
  }
  const runs = [...rows].sort(byCreatedAt);
  const { problems, notes } = commonRunProblems('lifecycle', runs, now);
  const succeeded = runs.filter((run) => run.status === 'succeeded');
  if (succeeded.length === 0) problems.push('no succeeded lifecycle run');
  notes.push(`${runs.length} lifecycle runs (${succeeded.length} succeeded)`);
  return { problems, notes };
}

export function checkMemoryItems(items) {
  if (items.length === 0) {
    return { problems: ['no memory items were extracted from a conversation full of personal facts'], notes: [] };
  }
  return {
    problems: [],
    notes: items.map((item) => `${item.kind}/${item.status}: ${item.claim}`),
  };
}
