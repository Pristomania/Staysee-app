/** Metadata sent to staysee-chat for pause-aware replies (not shown in UI). */

export interface TimeGapMeta {
  /** Browser clock at send time (ISO). */
  clientNowIso: string;
  /** IANA timezone when available, e.g. Europe/Moscow */
  timezone?: string;
  /** ISO timestamp of the previous user message in this conversation. */
  lastUserMessageAt: string;
  /** Milliseconds since lastUserMessageAt. */
  gapMs: number;
  gapMinutes: number;
}

/**
 * Build time-gap metadata from conversation messages (before the new outgoing message).
 * Returns undefined for the first user message in a thread.
 */
export function buildClientTimeGap(
  messages: Array<{ id: string; sender: string; created_at: string }>
): TimeGapMeta | undefined {
  const userMessages = messages.filter(
    (m) => m.sender === 'user' && m.id !== 'greeting' && !m.id.startsWith('temp-')
  );
  const last = userMessages[userMessages.length - 1];
  if (!last?.created_at) return undefined;

  const lastAt = new Date(last.created_at).getTime();
  if (Number.isNaN(lastAt)) return undefined;

  const now = Date.now();
  const gapMs = Math.max(0, now - lastAt);

  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timezone = undefined;
  }

  return {
    clientNowIso: new Date(now).toISOString(),
    timezone,
    lastUserMessageAt: last.created_at,
    gapMs,
    gapMinutes: Math.floor(gapMs / 60_000),
  };
}
