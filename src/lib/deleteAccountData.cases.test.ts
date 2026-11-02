/**
 * Run: npx tsx src/lib/deleteAccountData.cases.test.ts
 * "Delete the data of the account" (free plan): memory first, then notes, then conversations; the account, the plan,
 * the counter and the bought messages are not touched; a failed step stops the rest and says so.
 */

import { type AccountDataDeps, deleteAccountData, deleteAllMemory } from './deleteAccountData.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function fakeDeps(failing: string[] = []) {
  const calls: string[] = [];
  const step = (name: string) => async () => {
    calls.push(name);
    return { error: failing.includes(name) ? new Error(name) : null };
  };
  const deps: AccountDataDeps = {
    deleteMemoryV3: async (scope) => step(`memory:${scope}`)(),
    deleteLegacyMemory: step('legacy-memory'),
    deleteProgress: step('notes'),
    deleteConversations: step('conversations'),
  };
  return { deps, calls };
}

// All memory: between conversations, inside them, and the old table.
{
  const { deps, calls } = fakeDeps();
  assert((await deleteAllMemory('u1', deps)) === true, 'all memory goes');
  assert(calls.length === 3 && calls.includes('memory:account_wide') && calls.includes('memory:dialogue') && calls.includes('legacy-memory'), `all three memories: ${calls.join(',')}`);
  assert(!calls.includes('conversations') && !calls.includes('notes'), 'deleting memory leaves the conversations and the notes');
}
{
  const { deps } = fakeDeps(['memory:dialogue']);
  assert((await deleteAllMemory('u1', deps)) === false, 'one memory step failing is a failure');
}

// The data of the account: memory, then notes, then conversations, in this order.
{
  const { deps, calls } = fakeDeps();
  assert((await deleteAccountData('u1', deps)) === true, 'everything goes');
  assert(calls.slice(0, 3).sort().join() === ['legacy-memory', 'memory:account_wide', 'memory:dialogue'].sort().join(), 'memory first');
  assert(calls[3] === 'notes' && calls[4] === 'conversations' && calls.length === 5, `then notes, then conversations: ${calls.join(',')}`);
}

// A failed step stops what comes after it, and the whole thing reports failure (it is safe to run again).
{
  const { deps, calls } = fakeDeps(['legacy-memory']);
  assert((await deleteAccountData('u1', deps)) === false, 'memory failing is a failure');
  assert(!calls.includes('notes') && !calls.includes('conversations'), 'nothing after a failed memory step');
}
{
  const { deps, calls } = fakeDeps(['notes']);
  assert((await deleteAccountData('u1', deps)) === false && !calls.includes('conversations'), 'notes failing stops before the conversations');
}
{
  const { deps } = fakeDeps(['conversations']);
  assert((await deleteAccountData('u1', deps)) === false, 'conversations failing is a failure');
}

// The steps a person's data deletion may take are exactly these four: no plan, counter, pack or consent step exists.
{
  const { deps } = fakeDeps();
  assert(Object.keys(deps).sort().join() === ['deleteConversations', 'deleteLegacyMemory', 'deleteMemoryV3', 'deleteProgress'].join(), 'only data steps exist');
}

console.log('All deleteAccountData cases passed.');
