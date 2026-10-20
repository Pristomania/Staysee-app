/**
 * How long are people's messages, and does anyone hit the 10,000-character limit?
 * Read-only: calls the database function long_message_stats (counts only, never text).
 *
 *   node scripts/long-message-stats.mjs            # last 30 days
 *   node scripts/long-message-stats.mjs 90         # last 90 days
 */
import { formatLongMessageStats } from './lib/long-message-stats-format.mjs';
import { getServiceKey, getSupabaseUrl, loadEnvFile, makeServiceHeaders } from './lib/prod-test-env.mjs';

const days = Number(process.argv[2] ?? 30);
if (!Number.isInteger(days) || days < 1 || days > 3650) {
  console.error('The period must be a whole number of days between 1 and 3650.');
  process.exit(1);
}

// Read-only and counts only: it needs no test account and writes nothing.
const env = loadEnvFile();
const url = getSupabaseUrl(env);
const serviceKey = getServiceKey(env);
if (!url || !serviceKey) {
  console.error('Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const response = await fetch(`${url}/rest/v1/rpc/long_message_stats`, {
  method: 'POST',
  headers: { ...makeServiceHeaders(serviceKey), 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_days: days }),
});
if (!response.ok) {
  console.error(`The report failed: HTTP ${response.status}`);
  process.exit(1);
}
console.log(formatLongMessageStats(await response.json()));
