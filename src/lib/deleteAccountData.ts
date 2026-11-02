/**
 * Deleting what a person has stored without deleting the account, for the free plan: there the memory is not shown, so
 * the person must still be able to wipe it unseen. The account, the plan, the counter of messages, the bought messages
 * and the consents are not touched here: the counter is not a thing a person can reset by deleting their data.
 *
 * Every step reports an error the way Supabase does ({ error }), so the steps can be replaced in a test. Deleting is
 * safe to repeat: a failed run is simply run again.
 */
export interface AccountDataDeps {
  /** The memory built from conversations (migration of Memory V3): the one between conversations and the one inside them. */
  deleteMemoryV3(scope: 'account_wide' | 'dialogue'): Promise<{ error: unknown }>;
  /** The old memory table, which an older account may still hold. */
  deleteLegacyMemory(userId: string): Promise<{ error: unknown }>;
  /** The durable corrections ("lives with X"). A person has no right to delete these rows directly: a server function does it. */
  deleteCorrections(): Promise<{ error: unknown }>;
  /** Notes and the weekly pictures. They stay when a conversation is deleted (the link only becomes empty). */
  deleteProgress(userId: string): Promise<{ error: unknown }>;
  deleteConversations(userId: string): Promise<{ error: unknown }>;
}

/** All memory: between conversations, inside them, the corrections and the old table. True when every part was deleted. */
export async function deleteAllMemory(userId: string, deps: AccountDataDeps): Promise<boolean> {
  const results = await Promise.all([
    deps.deleteMemoryV3('account_wide'),
    deps.deleteMemoryV3('dialogue'),
    deps.deleteLegacyMemory(userId),
    deps.deleteCorrections(),
  ]);
  return results.every((result) => !result.error);
}

/** Memory first (the part the person cannot see), then notes, then the conversations. True when everything went. */
export async function deleteAccountData(userId: string, deps: AccountDataDeps): Promise<boolean> {
  if (!(await deleteAllMemory(userId, deps))) return false;
  if ((await deps.deleteProgress(userId)).error) return false;
  if ((await deps.deleteConversations(userId)).error) return false;
  return true;
}
