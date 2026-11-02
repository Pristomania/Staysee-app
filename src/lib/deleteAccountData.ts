/**
 * Deleting what a person has stored without deleting the account. The account, the plan, the counter of messages, the
 * bought messages and the consents are not touched here: the counter is not a thing a person can reset by deleting their
 * data.
 *
 * Both deletions are one call to the server (migration 092), which deletes in a single transaction and knows every table,
 * so that nothing is forgotten and nothing is half done. Each call reports an error the way Supabase does ({ error }), so
 * the steps can be replaced in a test. Deleting is safe to repeat: a failed run is simply run again.
 */
export interface AccountDataDeps {
  /** All memory in all its kinds: between conversations, inside them, the runs behind them, the corrections, the old table. */
  deleteMemoryContent(): Promise<{ error: unknown }>;
  /** Everything a person has written or that was built from it: conversations, notes, every kind of memory. */
  deleteAccountContent(): Promise<{ error: unknown }>;
}

/** "Delete all memory": the conversations and the notes stay. True when it all went. */
export async function deleteAllMemory(deps: AccountDataDeps): Promise<boolean> {
  return !(await deps.deleteMemoryContent()).error;
}

/** "Delete the data of the account" (free plan): the person's content and nothing of the plan. True when it all went. */
export async function deleteAccountData(deps: AccountDataDeps): Promise<boolean> {
  return !(await deps.deleteAccountContent()).error;
}
