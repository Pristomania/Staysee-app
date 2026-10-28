// "Запомнила" is shown only when the new memory really holds something new. The old way wrote the sentence into the
// old conversation summary, which is switched off, and showed the confirmation at once whatever happened next. The
// new memory stores a request to remember about ten seconds after the reply, in the background, and may decide
// not to store it, so the app looks: it takes a snapshot of the memory before asking, and after the reply it waits
// (briefly) until an item is new or updated. If none shows up, nothing is claimed.

export interface MemoryItemLike {
  memoryKey: string;
  updatedAt: string;
}

export type MemorySnapshot = Map<string, string>;

export function snapshotOfMemory(lists: { dialogue: MemoryItemLike[]; accountWide: MemoryItemLike[] }): MemorySnapshot {
  const snapshot: MemorySnapshot = new Map();
  for (const item of [...lists.dialogue, ...lists.accountWide]) snapshot.set(item.memoryKey, item.updatedAt);
  return snapshot;
}

/** A new item, or an existing one updated. An item that is gone does not count as "remembered". */
export function hasNewOrChangedItem(before: MemorySnapshot, after: MemorySnapshot): boolean {
  for (const [key, updatedAt] of after) {
    if (!before.has(key) || before.get(key) !== updatedAt) return true;
  }
  return false;
}

type MemoryReader = (
  conversationId: string,
) => Promise<{ dialogue: MemoryItemLike[]; accountWide: MemoryItemLike[]; error: string | null }>;

/** The memory as it is now, or null when it cannot be read (then nothing can be claimed). */
export async function takeMemorySnapshot(
  conversationId: string,
  read: MemoryReader = async (id) => (await import('./memoryV3Viewer')).fetchMemoryV3Items(id),
): Promise<MemorySnapshot | null> {
  try {
    const result = await read(conversationId);
    return result.error === null ? snapshotOfMemory(result) : null;
  } catch {
    return null;
  }
}

/** True once the memory has something new or updated since `before`; false at the time limit. Never throws. */
export async function waitForRememberedItem(options: {
  before: MemorySnapshot | null;
  takeSnapshot: () => Promise<MemorySnapshot | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<boolean> {
  if (options.before === null) return false;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 45_000;
  const intervalMs = options.intervalMs ?? 4_000;
  const deadline = now() + timeoutMs;
  try {
    for (;;) {
      await sleep(intervalMs);
      const current = await options.takeSnapshot();
      if (current !== null && hasNewOrChangedItem(options.before, current)) return true;
      if (now() + intervalMs > deadline) return false;
    }
  } catch {
    return false;
  }
}
