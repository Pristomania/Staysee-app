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

/**
 * The on-device voice engine is served from public/ and is not referenced
 * from index.html, so nothing else in the build would notice if it went
 * missing. Without these two files local dictation cannot start at all.
 * Replacing the engine means updating these byte counts on purpose.
 */
const engineFiles = [
  ['sherpa-onnx-asr.js', 41274],
  ['sherpa-onnx-wasm-main-asr.js', 92139],
];
for (const [name, expectedBytes] of engineFiles) {
  const enginePath = path.join(process.cwd(), 'dist', 'voice-engine', name);
  if (!fs.existsSync(enginePath)) {
    console.error(`[verify-prod-bundle] dist/voice-engine/${name} is missing — on-device voice input cannot start`);
    process.exit(1);
  }
  const actualBytes = fs.statSync(enginePath).size;
  if (actualBytes !== expectedBytes) {
    console.error(`[verify-prod-bundle] dist/voice-engine/${name} is ${actualBytes} bytes, expected ${expectedBytes}`);
    process.exit(1);
  }
}

// A check for the recognition worker/capture worklet markers in dist/assets
// belongs here once the local adapter is actually wired into the app
// (useVoiceDictation.ts still builds the browser adapter only) -- until
// then nothing imports local​VoiceDictation.ts, so Vite never bundles
// voiceRecognitionWorker.ts at all, and the markers can never be present.
// Add this back as part of that wiring change, not before it.

console.log('[verify-prod-bundle] OK — no direct supabase.co / openrouter in dist');
