/**
 * Run: npx tsx supabase/functions/_shared/deleteAccountDataDeps.cases.test.ts
 * What the real steps of "delete the data of the account" and "delete all memory" call: one server function each, and
 * nothing that is the plan's (no plan, counter, bought messages or consents). Read from the source, because the steps
 * need a database.
 */

import { readFileSync } from 'node:fs';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const source = readFileSync(new URL('../../../src/lib/deleteAccountDataDeps.ts', import.meta.url), 'utf8');
const rules = readFileSync(new URL('../../../src/lib/deleteAccountData.ts', import.meta.url), 'utf8');

// Each deletion is one server function (migration 092).
assert(source.includes(".rpc('delete_my_memory')"), 'all memory goes through delete_my_memory');
assert(source.includes(".rpc('delete_my_account_data')"), 'the data of the account goes through delete_my_account_data');

// No table is deleted piecemeal from the app (that is how tables, and the runs behind the memory, got forgotten).
assert(!/\.from\(/.test(source) && !/\.from\(/.test(rules), 'the app deletes no table directly');

// Nothing that belongs to the plan or to the money.
for (const table of ['user_usage_tiers', 'message_packs', 'user_consents', 'ai_usage_logs', 'profiles']) {
  assert(!source.includes(table) && !rules.includes(table), `the data deletion never touches ${table}`);
}

console.log('All deleteAccountDataDeps cases passed.');
