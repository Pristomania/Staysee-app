/**
 * Technical / audit / smoke conversation title patterns.
 * Keep in sync with src/lib/conversationFilters.ts (HIDDEN_TITLE_RE).
 */

export const TEST_CONVERSATION_TITLE_RE =
  /^(?:__(?:TEST|audit)|post-fix smoke|audit(?:\s|[-_])|prod smoke|staging smoke|exact-test|depth-arc-smoke|audit-uncertainty)/i;

export function isTestConversationTitle(title) {
  const t = (title ?? "").trim();
  if (!t) return false;
  return TEST_CONVERSATION_TITLE_RE.test(t);
}
