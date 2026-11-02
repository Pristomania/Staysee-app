/**
 * Run: npx tsx src/lib/deleteAccountData.cases.test.ts
 * "Delete the data of the account" (free plan) is one server call that deletes the person's content and nothing of the
 * plan; "delete all memory" is the memory in all its kinds, the corrections included. A failed step says so.
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
    deleteCorrections: step('corrections'),
    deleteAccountContent: step('content'),
  };
  return { deps, calls };
}

// All memory: between conversations, inside them, the corrections and the old table.
{
  const { deps, calls } = fakeDeps();
  assert((await deleteAllMemory('u1', deps)) === true, 'all memory goes');
  assert(calls.length === 4 && calls.includes('memory:account_wide') && calls.includes('memory:dialogue') && calls.includes('legacy-memory') && calls.includes('corrections'), `all four memories: ${calls.join(',')}`);
  assert(!calls.includes('content'), 'deleting memory leaves the conversations and the notes');
}
{
  const { deps } = fakeDeps(['memory:dialogue']);
  assert((await deleteAllMemory('u1', deps)) === false, 'one memory step failing is a failure');
}
{
  // the corrections are part of "all memory": without them the screen would say the memory is gone while they still shape answers
  const { deps } = fakeDeps(['corrections']);
  assert((await deleteAllMemory('u1', deps)) === false, 'the corrections failing is a failure');
}

// The data of the account: one call, and it is all.
{
  const { deps, calls } = fakeDeps();
  assert((await deleteAccountData(deps)) === true, 'everything goes');
  assert(calls.length === 1 && calls[0] === 'content', `one server call, nothing piecemeal: ${calls.join(',')}`);
}
{
  const { deps } = fakeDeps(['content']);
  assert((await deleteAccountData(deps)) === false, 'a failed deletion says so (it is safe to run again)');
}

// The only steps there are are data steps: no plan, counter, pack or consent step exists.
{
  const { deps } = fakeDeps();
  assert(Object.keys(deps).sort().join() === ['deleteAccountContent', 'deleteCorrections', 'deleteLegacyMemory', 'deleteMemoryV3'].join(), 'only data steps exist');
}

console.log('All deleteAccountData cases passed.');
