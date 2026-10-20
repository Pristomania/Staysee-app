import { reportOverLimit, shouldReportOverLimit } from './overLimitReport.ts';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// One report each time the text goes over the maximum, not on every key press while it stays over.
assertEqual(shouldReportOverLimit(false, true), true, 'goes over');
assertEqual(shouldReportOverLimit(true, true), false, 'stays over');
assertEqual(shouldReportOverLimit(true, false), false, 'comes back under');
assertEqual(shouldReportOverLimit(false, false), false, 'stays under');

// The report carries only the length, to the one database function made for it.
const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
await reportOverLimit(12_345, async (name, args) => {
  calls.push({ name, args });
  return { error: null };
});
assertEqual(calls, [{ name: 'record_over_limit_hit', args: { p_char_count: 12_345 } }], 'rpc call');

// A report that fails, or a connection that breaks, never reaches the person.
await reportOverLimit(12_345, async () => ({ error: { message: 'boom' } }));
await reportOverLimit(12_345, async () => {
  throw new Error('network down');
});

console.log('overLimitReport: all checks passed');
