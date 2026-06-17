/** Hide internal prod smoke / audit conversations from user-facing lists. */

const HIDDEN_TITLE_RE =
  /^(?:__TEST__|post-fix smoke|audit(?:\s|[-_])|prod smoke|exact-test|depth-arc-smoke|audit-uncertainty)/i;

export function isHiddenTestConversation(title: string | null | undefined): boolean {
  const t = (title ?? '').trim();
  if (!t) return false;
  return HIDDEN_TITLE_RE.test(t);
}

export function filterVisibleConversations<T extends { title?: string | null }>(
  conversations: T[]
): T[] {
  return conversations.filter((c) => !isHiddenTestConversation(c.title));
}
