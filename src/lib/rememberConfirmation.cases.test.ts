import {
  hasNewOrChangedItem,
  snapshotOfMemory,
  takeMemorySnapshot,
  waitForRememberedItem,
} from './rememberConfirmation.ts';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const item = (memoryKey: string, updatedAt: string) => ({ memoryKey, updatedAt });

// A snapshot is "which items exist and when each was last updated", over the conversation and the whole account.
const snapshot = snapshotOfMemory({
  dialogue: [item('a', '2026-10-28T10:00:00Z')],
  accountWide: [item('b', '2026-10-28T11:00:00Z')],
});
assertEqual([...snapshot.entries()], [['a', '2026-10-28T10:00:00Z'], ['b', '2026-10-28T11:00:00Z']], 'snapshot');

// Remembered = a new item appeared, or an existing one was updated. Nothing else counts.
assertEqual(hasNewOrChangedItem(snapshot, snapshot), false, 'nothing changed');
assertEqual(hasNewOrChangedItem(snapshot, new Map([...snapshot, ['c', '2026-10-28T12:00:00Z']])), true, 'a new item');
assertEqual(hasNewOrChangedItem(snapshot, new Map([['a', '2026-10-28T10:05:00Z'], ['b', '2026-10-28T11:00:00Z']])), true, 'an item updated');
assertEqual(hasNewOrChangedItem(snapshot, new Map([['a', '2026-10-28T10:00:00Z']])), false, 'an item disappearing is not "remembered"');

// The snapshot of the live memory: null when it cannot be read, so that nothing is claimed.
const taken = await takeMemorySnapshot('c1', async () => ({ accountWide: [], dialogue: [item('a', 't1')], error: null }));
assertEqual([...(taken ?? [])], [['a', 't1']], 'snapshot entries');
assertEqual(await takeMemorySnapshot('c1', async () => ({ accountWide: [], dialogue: [], error: 'network' })), null, 'unreadable memory');

function clock() {
  let now = 0;
  const sleeps: number[] = [];
  return { sleeps, now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
}

// Waits and looks again until the new memory really holds something new.
{
  const c = clock();
  let looks = 0;
  const stored = await waitForRememberedItem({
    before: new Map([['a', 't1']]),
    takeSnapshot: async () => {
      looks += 1;
      return looks < 3 ? new Map([['a', 't1']]) : new Map([['a', 't1'], ['b', 't2']]);
    },
    now: c.now,
    sleep: c.sleep,
    intervalMs: 4_000,
  });
  assertEqual(stored, true, 'found after waiting');
  assertEqual(looks, 3, 'looked three times');
  assertEqual(c.sleeps, [4_000, 4_000, 4_000], 'waited between looks');
}

// Nothing new within the time limit: false, and so no confirmation is shown.
{
  const c = clock();
  const stored = await waitForRememberedItem({
    before: new Map(),
    takeSnapshot: async () => new Map(),
    now: c.now,
    sleep: c.sleep,
    timeoutMs: 20_000,
    intervalMs: 4_000,
  });
  assertEqual(stored, false, 'nothing within the limit');
  assertEqual(c.sleeps.reduce((sum, ms) => sum + ms, 0) <= 24_000, true, 'stopped at the limit');
}

// No snapshot from before the request: nothing can be claimed, and nothing is looked at.
{
  let looked = false;
  const stored = await waitForRememberedItem({
    before: null,
    takeSnapshot: async () => { looked = true; return new Map(); },
    sleep: async () => {},
  });
  assertEqual([stored, looked], [false, false], 'no starting point');
}

// A failing look just means it stops: no claim, no error for the person.
{
  const c = clock();
  const stored = await waitForRememberedItem({
    before: new Map(),
    takeSnapshot: async () => { throw new Error('network down'); },
    now: c.now,
    sleep: c.sleep,
  });
  assertEqual(stored, false, 'a failing look');
}

console.log('rememberConfirmation: all checks passed');
