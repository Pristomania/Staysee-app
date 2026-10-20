/**
 * One second attempt before a Memory V3 failure is reported. The owner is
 * alerted only when the retry fails too, so a single network blip or an
 * unlucky overlap of two runs no longer sends an alert.
 *
 * Nothing here can lose data: a failed run never advances the conversation's
 * cursor, so the next attempt reads the same messages again.
 */

// Ten seconds, not two: a rate limit or a provider hiccup rarely clears in two,
// and nothing here is user-facing (the run is a background task). Worst case a
// run now waits this long once per model call.
export const MEMORY_V3_RETRY_DELAY_MS = 10_000;

// Failures where asking again can help: the connection broke or timed out, the
// provider answered 5xx, or answered 4xx (this includes rate limiting; a
// permanent 4xx simply fails again at no cost). Not "provider_response_invalid":
// that answer arrived and was paid for, it was just unusable.
const TRANSIENT = new Set(["transport_failed", "transport_timeout", "provider_http_5xx", "provider_http_4xx"]);

type Sleep = { sleep?: (ms: number) => Promise<void> };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Wraps a model adapter: a transient failure is retried once, after a short
// wait. The second outcome is final, success or the second error.
export function withOneTransientRetry<Input, Output>(
  call: (input: Input) => Promise<Output>,
  diagnosticOf: (error: unknown) => string | null,
  options: Sleep = {},
): (input: Input) => Promise<Output> {
  const sleep = options.sleep ?? defaultSleep;
  return async (input) => {
    try {
      return await call(input);
    } catch (error) {
      const diagnostic = diagnosticOf(error);
      if (diagnostic === null || !TRANSIENT.has(diagnostic)) throw error;
    }
    await sleep(MEMORY_V3_RETRY_DELAY_MS);
    return await call(input);
  };
}

// Two runs for the same conversation (or account) that overlap can both read
// the same memory state; the one finishing second finds it changed and its write
// is refused ("state_conflict"; the database has already closed that run). Running
// it again re-reads the state and takes only what the first did not cover. When
// nothing new arrived in the pause, the database recognises the identical window
// and skips the rerun ("duplicate"); that is not a failure either, because the
// refused run never moved the conversation's cursor, so the next reply's run
// reads the missed messages again (tests/db/conflictRecovery.dbtest.ts).
export async function runWithOneConflictRetry<Result extends { status: string }>(
  run: () => Promise<Result>,
  options: Sleep = {},
): Promise<Result> {
  const sleep = options.sleep ?? defaultSleep;
  const first = await run();
  const code = (first as { diagnosticCode?: unknown }).diagnosticCode;
  if (first.status !== "failed" || code !== "state_conflict") return first;
  await sleep(MEMORY_V3_RETRY_DELAY_MS);
  return await run();
}
