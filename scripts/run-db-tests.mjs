// Runs the database integration tests in tests/db against a LOCAL Supabase.
//
//   npx supabase start
//   eval "$(npx supabase status -o env)"
//   SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" npm run test:db
//
// These tests create and delete users and data, so they REFUSE to run against
// anything but a local database. Without connection settings they skip
// (exit 0) unless REQUIRE_DB_TESTS=1, which CI sets so a missing database can
// never pass silently.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIRECTORY = join(PROJECT_ROOT, 'tests', 'db');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  const message = '[test:db] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set (see the header of scripts/run-db-tests.mjs).';
  if (process.env.REQUIRE_DB_TESTS === '1') {
    console.error(`${message} REQUIRE_DB_TESTS=1, so this is a failure.`);
    process.exit(1);
  }
  console.log(`${message} Skipping.`);
  process.exit(0);
}

let host;
try {
  host = new URL(url).hostname;
} catch {
  console.error('[test:db] SUPABASE_URL is not a valid URL.');
  process.exit(1);
}
if (!LOCAL_HOSTS.has(host)) {
  console.error(`[test:db] Refusing to run against "${host}": these tests create and delete data, so they only run against a local Supabase.`);
  process.exit(1);
}

const files = readdirSync(TEST_DIRECTORY)
  .filter((name) => name.endsWith('.dbtest.ts'))
  .sort()
  .map((name) => join(TEST_DIRECTORY, name));

if (files.length === 0) {
  console.error('[test:db] No *.dbtest.ts files found in tests/db.');
  process.exit(1);
}

// One file at a time: every file seeds and deletes its own user, but they share one database.
const result = spawnSync(
  process.execPath,
  [join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--test', '--test-concurrency=1', ...files],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
