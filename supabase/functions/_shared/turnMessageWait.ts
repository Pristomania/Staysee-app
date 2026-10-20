/**
 * The website asks the chat for a reply first and saves the turn's messages afterwards. The background memory
 * run starts as soon as the reply is ready, so for the first message of a conversation it could read the
 * conversation before the message was saved and find nothing (invalid_source: an alert, and no run).
 * This waits, briefly, until the message the run is about to read exists. It never throws and gives up after
 * the time limit, so a message that never arrives cannot hold the run.
 */

export async function waitForUserMessageSaved(options: {
  /** The conversation's latest messages from the person, newest first. */
  load: () => Promise<Array<{ content: string; created_at: string }>>;
  /** What the person sent in this turn. */
  text: string;
  /** Only a message saved after this moment (ms since the epoch) is the one. */
  sinceMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<boolean> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 500;
  const wanted = options.text.trim();
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const rows = await options.load();
      if (rows.some((row) => row.content.trim() === wanted && Date.parse(row.created_at) >= options.sinceMs)) return true;
    } catch {
      return false;
    }
    if (now() + intervalMs > deadline) return false;
    await sleep(intervalMs);
  }
}
