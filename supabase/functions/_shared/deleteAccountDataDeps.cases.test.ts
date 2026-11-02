/**
 * Run: npx tsx supabase/functions/_shared/deleteAccountDataDeps.cases.test.ts
 * What the real steps of "delete the data of the account" touch: the person's memory, notes and conversations, and
 * nothing that is the plan's: no plan, counter, bought messages or consents. Read from the source, because the steps
 * need a database to run.
 */

import { readFileSync } from 'node:fs';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const source = readFileSync(new URL('../../../src/lib/deleteAccountDataDeps.ts', import.meta.url), 'utf8');

// Every part of the memory and the data is reached, each in its own way.
for (const part of [
  "deleteAllMemoryV3Data(scope)", // between conversations ('account_wide') and inside them ('dialogue') are both passed by the caller
  ".from('user_memory').delete()",
  ".from('progress_entries').delete()",
  ".from('conversations').delete()",
  ".rpc('delete_my_memory_corrections')", // a person cannot delete these rows directly: a server function does it
]) {
  assert(source.includes(part), `the real steps reach: ${part}`);
}

// ... and the caller asks for both memory scopes.
const rules = readFileSync(new URL('../../../src/lib/deleteAccountData.ts', import.meta.url), 'utf8');
assert(rules.includes("deps.deleteMemoryV3('account_wide')") && rules.includes("deps.deleteMemoryV3('dialogue')"), 'both memory scopes are deleted');

// Nothing that belongs to the plan or to the money.
for (const table of ['user_usage_tiers', 'message_packs', 'user_consents', 'ai_usage_logs', 'profiles']) {
  assert(!source.includes(table) && !rules.includes(table), `the data deletion never touches ${table}`);
}

// Every deletion is bound to the person: the table steps filter by the user's id.
assert((source.match(/\.eq\('user_id', userId\)/g) ?? []).length === 3, 'the three table steps filter by the user id');

console.log('All deleteAccountDataDeps cases passed.');
