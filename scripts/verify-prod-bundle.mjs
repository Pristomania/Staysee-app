/**
 * Fail build if bundled JS still references direct Supabase / OpenRouter hosts.
 */
import fs from 'node:fs';
import path from 'node:path';

const distAssets = path.join(process.cwd(), 'dist', 'assets');
/** Project-specific direct host (must use staysee.ru/supabase proxy in prod). */
const forbidden = [
  'jnxrildlwvtxhtiwucbt.supabase.co',
  'https://supabase.co',
  'openrouter.ai',
  'OPENROUTER_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];
const requiredProxy = 'staysee.ru/supabase';

if (!fs.existsSync(distAssets)) {
  console.error('[verify-prod-bundle] dist/assets not found — run vite build first');
  process.exit(1);
}

const hits = [];
for (const name of fs.readdirSync(distAssets)) {
  if (!name.endsWith('.js')) continue;
  const text = fs.readFileSync(path.join(distAssets, name), 'utf8');
  for (const needle of forbidden) {
    if (text.includes(needle)) hits.push({ file: name, needle });
  }
}

if (hits.length) {
  console.error('[verify-prod-bundle] Forbidden hosts/secrets in production bundle:');
  for (const h of hits) console.error(`  ${h.file}: ${h.needle}`);
  process.exit(1);
}

const jsFiles = fs.readdirSync(distAssets).filter((n) => n.endsWith('.js'));
const bundled = jsFiles.map((n) => fs.readFileSync(path.join(distAssets, n), 'utf8')).join('\n');
if (!bundled.includes(requiredProxy)) {
  console.error(`[verify-prod-bundle] Missing ${requiredProxy} in bundle — check .env.production`);
  process.exit(1);
}

console.log('[verify-prod-bundle] OK — no direct supabase.co / openrouter in dist');
