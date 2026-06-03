/**
 * One-time prod setup for memory: mark existing migrations applied, push 011, deploy staysee-chat.
 * Run: node scripts/setup-memory-prod.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const APPLIED_VERSIONS = [
  '20260523230541',
  '20260524192515',
  '20260524201455',
  '20260524231158',
  '20260524234335',
  '20260524234434',
  '20260525002548',
  '20260525004144',
  '20260527120000',
];

function run(args, opts = {}) {
  console.log('\n> npx supabase', args.join(' '));
  const r = spawnSync('npx', ['supabase', ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    ...opts,
  });
  return r.status === 0;
}

console.log('StaySee memory prod setup\n');

for (const v of APPLIED_VERSIONS) {
  if (!run(['migration', 'repair', v, '--status', 'applied'])) {
    console.error(`Failed to repair migration ${v}`);
    process.exit(1);
  }
}

// 011 may fail if user_memory was never created; 012 ensures the table + policies.
run(['migration', 'repair', '20260528120000', '--status', 'applied']);

if (!run(['db', 'push', '--yes'])) {
  console.error('db push failed');
  process.exit(1);
}

if (!run(['functions', 'deploy', 'staysee-chat', '--project-ref', 'jnxrildlwvtxhtiwucbt'])) {
  console.error('functions deploy failed');
  process.exit(1);
}

console.log('\nDone: migration 011 applied, staysee-chat deployed.');
