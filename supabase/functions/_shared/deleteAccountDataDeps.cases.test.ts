/**
 * Run: npx tsx supabase/functions/_shared/deleteAccountDataDeps.cases.test.ts
 * What the real steps of "delete the data of the account" and "delete all memory" call: the person's content goes through
 * one server function, the memory through the memory viewer, the old table and the corrections function, and nothing that
 * is the plan's (no plan, counter, bought messages or consents). Read from the source, because the steps need a database.
 */

import { readFileSync } from 'node:fs';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const source = readFileSync(new URL('../../../src/lib/deleteAccountDataDeps.ts', import.meta.url), 'utf8');
const rules = readFileSync(new URL('../../../src/lib/deleteAccountData.ts', import.meta.url), 'utf8');

// Every part of the memory and of the data is reached, each in its own way.
for (const part of [
  'deleteAllMemoryV3Data(scope)', // between conversations ('account_wide') and inside them ('dialogue') are both passed by the caller
  ".from('user_memory').delete().eq('user_id', userId)",
  ".rpc('delete_my_memory_corrections')", // a person cannot delete these rows directly: a server function does it
  ".rpc('delete_my_account_data')", // all content in one transaction on the server
]) {
  assert(source.includes(part), `the real steps reach: ${part}`);
}

// The data deletion is one server call: no table is deleted piecemeal from the app (that is how tables got forgotten).
assert(!source.includes(".from('conversations')") && !source.includes(".from('progress_entries')"), 'conversations and notes go through the server function, not from the app');

// ... and the memory caller asks for both memory scopes.
assert(rules.includes("deps.deleteMemoryV3('account_wide')") && rules.includes("deps.deleteMemoryV3('dialogue')"), 'both memory scopes are deleted');

// Nothing that belongs to the plan or to the money.
for (const table of ['user_usage_tiers', 'message_packs', 'user_consents', 'ai_usage_logs', 'profiles']) {
  assert(!source.includes(table) && !rules.includes(table), `the data deletion never touches ${table}`);
}

console.log('All deleteAccountDataDeps cases passed.');
