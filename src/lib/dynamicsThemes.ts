import { normalizeDedupKey } from './memoryDisplay';
import type { MemoryV3ExportItem } from './memoryV3Viewer';

export const MAX_REPEATING_THEMES = 8;

/**
 * "Что повторяется" on the conversation dynamics screen: the recurring patterns the new
 * memory has confirmed for THIS conversation (a pattern needs at least two separate
 * episodes the person lived through, so it is stricter than the old summary's topic labels
 * and stays empty in short conversations).
 *
 * Deliberately not shown here: facts (not a pattern), hypotheses (the app's guesses, never
 * to be presented as the person's repeating behaviour), other chats' items and account-wide
 * items (a chat's screen shows only that chat), and patterns already replaced by a newer one.
 */
export function selectRepeatingThemes(items: MemoryV3ExportItem[], conversationId: string): string[] {
  const live = items
    .filter(
      (item) =>
        item.kind === 'recurrence' &&
        item.conversationId === conversationId &&
        item.replacedByMemoryKey === null,
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  const themes: string[] = [];
  const seen = new Set<string>();
  for (const item of live) {
    const text = item.claim.trim();
    if (!text) continue;
    const key = normalizeDedupKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    themes.push(text);
    if (themes.length >= MAX_REPEATING_THEMES) break;
  }
  return themes;
}
