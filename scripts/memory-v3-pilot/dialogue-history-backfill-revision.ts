/** Captures each conversation's current dialogue-state revision right
 * before the paid run starts, so the import step can later verify
 * nothing changed in between (see dialogue-history-backfill-import.ts).
 * This never excludes a conversation -- Настя explicitly asked for every
 * conversation to be reprocessed, including ones that already have live
 * data (2026-09-24) -- it only records a number to check against later. */

export interface DialogueRevisionReader {
  (conversationId: string): Promise<number>;
}

export async function captureConversationRevisions(
  conversationIds: readonly string[],
  readRevision: DialogueRevisionReader,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const conversationId of conversationIds) {
    result.set(conversationId, await readRevision(conversationId));
  }
  return result;
}
