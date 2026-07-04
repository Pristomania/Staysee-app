/**
 * First-chat privacy notice — client-only state and UI event log.
 * No server/AI/memory writes; no DB migration required.
 */

const ACCEPTED_PREFIX = 'staysee-privacy-notice-accepted:';
const UI_EVENTS_KEY = 'staysee-ui-events';
const MAX_UI_EVENTS = 200;

export interface PrivacyNoticeAcceptedEvent {
  event: 'privacy_notice_accepted';
  user_id: string;
  conversation_id: string;
  created_at: string;
}

function readUiEvents(): PrivacyNoticeAcceptedEvent[] {
  try {
    const raw = localStorage.getItem(UI_EVENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PrivacyNoticeAcceptedEvent =>
        !!e &&
        typeof e === 'object' &&
        (e as PrivacyNoticeAcceptedEvent).event === 'privacy_notice_accepted' &&
        typeof (e as PrivacyNoticeAcceptedEvent).user_id === 'string' &&
        typeof (e as PrivacyNoticeAcceptedEvent).conversation_id === 'string',
    );
  } catch {
    return [];
  }
}

export function isPrivacyNoticeAccepted(conversationId: string): boolean {
  if (!conversationId) return false;
  try {
    return localStorage.getItem(`${ACCEPTED_PREFIX}${conversationId}`) === '1';
  } catch {
    return false;
  }
}

/** Persist dismiss + append client-side UI event log (no server table in schema today). */
export function markPrivacyNoticeAccepted(input: {
  userId: string;
  conversationId: string;
}): void {
  const created_at = new Date().toISOString();
  try {
    localStorage.setItem(`${ACCEPTED_PREFIX}${input.conversationId}`, '1');
    const entry: PrivacyNoticeAcceptedEvent = {
      event: 'privacy_notice_accepted',
      user_id: input.userId,
      conversation_id: input.conversationId,
      created_at,
    };
    const next = [...readUiEvents(), entry].slice(-MAX_UI_EVENTS);
    localStorage.setItem(UI_EVENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — notice may reappear on refresh */
  }
}

export function listPrivacyNoticeEvents(): PrivacyNoticeAcceptedEvent[] {
  return readUiEvents();
}
