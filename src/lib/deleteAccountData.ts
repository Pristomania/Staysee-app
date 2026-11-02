/**
 * Deleting what a person has stored without deleting the account, for the free plan: there the memory is not shown, so
 * the person must still be able to wipe it unseen. The account, the plan, the counter of messages, the bought messages
 * and the consents are not touched here: the counter is not a thing a person can reset by deleting their data.
 *
 * Every step reports an error the way Supabase does ({ error }), so the steps can be replaced in a test. Deleting is
 * safe to repeat: a failed run is simply run again.
 */
export interface AccountDataDeps {
  /** The memory built from conversations: the one between conversations ('account_wide') and the one inside them ('dialogue'). */
  deleteMemoryV3(scope: 'account_wide' | 'dialogue'): Promise<{ error: unknown }>;
  /** The old memory table, which an older account may still hold. */
  deleteLegacyMemory(userId: string): Promise<{ error: unknown }>;
  /** The durable corrections ("lives with X"). A person has no right to delete these rows directly: a server function does it. */
  deleteCorrections(): Promise<{ error: unknown }>;
  /**
   * Everything a person has written or that was built from it (conversations, notes, every kind of memory, corrections),
   * deleted by the server in one transaction (migration 092), so that nothing is forgotten and nothing is half done.
   */
  deleteAccountContent(): Promise<{ error: unknown }>;
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

/** The data of the account: one server call that deletes all of the person's content and nothing of the plan. */
export async function deleteAccountData(deps: AccountDataDeps): Promise<boolean> {
  return !(await deps.deleteAccountContent()).error;
}
