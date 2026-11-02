/**
 * Run: npx tsx src/lib/deleteAccountData.cases.test.ts
 * "Delete the data of the account" (free plan) and "delete all memory" are each one server call; the first deletes the
 * person's content, the second only the memory, and neither touches the plan. A failed call says so.
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
    deleteMemoryContent: step('memory'),
    deleteAccountContent: step('content'),
  };
  return { deps, calls };
}

// All memory: one call, and it leaves the conversations and the notes.
{
  const { deps, calls } = fakeDeps();
  assert((await deleteAllMemory(deps)) === true, 'all memory goes');
  assert(calls.length === 1 && calls[0] === 'memory', `one server call for the memory only: ${calls.join(',')}`);
}
{
  const { deps } = fakeDeps(['memory']);
  assert((await deleteAllMemory(deps)) === false, 'a failed memory deletion says so (it is safe to run again)');
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
  assert(Object.keys(deps).sort().join() === ['deleteAccountContent', 'deleteMemoryContent'].join(), 'only data steps exist');
}

console.log('All deleteAccountData cases passed.');
