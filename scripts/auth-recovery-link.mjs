/**
 * Generate a one-time password recovery link (admin).
 * Usage: node scripts/auth-recovery-link.mjs your@email.com
 * Opens in browser — must match Redirect URLs in Supabase Dashboard.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadEnv() {
  try {
    const raw = readFileSync(resolve(root, '.env'), 'utf8');
    const env = {};
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch {
    return {};
  }
}

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/auth-recovery-link.mjs your@email.com');
  process.exit(1);
}

const env = loadEnv();
const url = env.VITE_SUPABASE_URL ?? env.SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const redirectTo = process.env.REDIRECT_TO ?? 'http://localhost:5173';

if (!url || !serviceKey) {
  console.error('Need VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await admin.auth.admin.generateLink({
  type: 'recovery',
  email,
  options: { redirectTo },
});

if (error) {
  console.error(error.message);
  process.exit(1);
}

console.log('\nRecovery link (one-time, open in browser):\n');
console.log(data.properties.action_link);
console.log('\nRedirect after click:', redirectTo);
console.log('');
