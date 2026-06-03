/**
 * Generate a signup / email-confirm link (admin) — same flow as письмо «Подтвердить email».
 * Usage: node scripts/auth-signup-link.mjs your@email.com [password]
 * Password defaults to SIGNUP_TEST_PASSWORD or "StayseeTest1" (only for link generation).
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
const password = process.argv[3] ?? process.env.SIGNUP_TEST_PASSWORD ?? 'StayseeTest1';

if (!email) {
  console.error('Usage: node scripts/auth-signup-link.mjs your@email.com [password]');
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
  type: 'signup',
  email,
  password,
  options: { redirectTo },
});

if (error) {
  console.error(error.message);
  console.error('\nIf user already exists: delete in Dashboard → Users, or use normal login.');
  process.exit(1);
}

console.log('\nSignup / confirm link (open in browser with npm run dev):\n');
console.log(data.properties.action_link);
console.log('\nAfter click: should land in app (main/onboarding), NOT reset-password.');
console.log('Redirect:', redirectTo);
console.log('');
