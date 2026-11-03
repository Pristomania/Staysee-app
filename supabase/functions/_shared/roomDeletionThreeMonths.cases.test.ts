/**
 * Run: npx tsx supabase/functions/_shared/roomDeletionThreeMonths.cases.test.ts
 * A deleted room keeps its sign-in record for 3 months (migration 093), so that deleting the room and signing up again
 * cannot hand out the 50 free messages anew; the person is shown the exact day the address opens again, and the
 * exact day their messages come back. Read from the sources, because the screens and the database need a runtime.
 */

import { readFileSync } from 'node:fs';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

// ── the database ────────────────────────────────────────────────────────────────────────────────────────
const migration = read('supabase/migrations/20261104090000_093_room_deletion_three_months.sql');
assert(/CREATE OR REPLACE FUNCTION public\.request_room_deletion\(\)/.test(migration), 'the function is replaced, not a new one added');
assert(/interval '3 months'/.test(migration) && !/interval '14 days'/.test(migration), 'three months, not fourteen days');
// The date is a whole UTC day, the day after the three months, so that the daily job (03:23 UTC) of that day has run
// before the person is told the address is free: "from 4 February" is then true on the 4th, not only in the evening.
assert(/AT TIME ZONE 'utc'/i.test(migration) && /interval '1 day'/.test(migration), 'the date is the whole UTC day after the three months');
assert(/SECURITY DEFINER/.test(migration) && /SET search_path = ''/.test(migration), 'still a definer function with an empty search path');
assert(/room_deletion_requested_at IS NOT NULL AND room_purge_after IS NOT NULL/.test(migration), 'asking twice returns the same date');
assert(/_wipe_account_content\(v_uid\)/.test(migration), 'the content is still wiped at once');
assert(/DELETE FROM public\.user_usage_tiers/.test(migration) && /DELETE FROM public\.ai_usage_logs/.test(migration), 'the plan and the usage log still go at once');
assert(/REVOKE ALL ON FUNCTION public\.request_room_deletion\(\) FROM anon/.test(migration), 'anon cannot call it');
assert(/GRANT EXECUTE ON FUNCTION public\.request_room_deletion\(\) TO authenticated/.test(migration), 'a signed-in person can');
assert(!/purge_scheduled_rooms|cron\./.test(migration), 'the daily clean-up is not touched');

// ── the app ─────────────────────────────────────────────────────────────────────────────────────────────
const auth = read('src/context/AuthContext.tsx');
assert(/select\('room_deletion_requested_at, ?room_purge_after'\)/.test(auth), 'signing in reads the day the address opens again');
assert(/availableFrom/.test(auth), 'and passes it on with the error');

const login = read('src/components/screens/LoginScreen.tsx');
assert(/roomDeletedLoginText\(/.test(login), 'the sign-in screen shows the dated text');

const chat = read('src/components/screens/ChatScreen.tsx');
assert(/exhaustedReply\(/.test(chat), 'a refused message shows the day the messages come back');
assert(/aiResult\.status === 'rate_limit'/.test(chat), 'only for the refusal of the limit, never for another failure');

console.log('All roomDeletionThreeMonths cases passed.');
