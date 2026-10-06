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

/**
 * The recognition worker and the capture worklet are referenced only from
 * JS chunks, so scripts/smoke-built-site.mjs (which walks index.html) would
 * not notice either of them vanishing. `zipformer2` is a string literal in
 * the recognizer config and survives minification as plain text in the
 * worker chunk. `registerProcessor('voice-capture'` does NOT survive as
 * plain text when the worklet is small enough for Vite to inline it as a
 * base64 data: URL (true today -- the file is 1,892 bytes, under Vite's
 * 4096-byte assetsInlineLimit) -- so this also decodes every inlined
 * base64 asset and searches the decoded text too, which keeps working
 * whether the worklet stays inlined or later grows past the threshold and
 * gets emitted as its own file instead.
 */
const assetTexts = jsFiles.map((name) => fs.readFileSync(path.join(distAssets, name), 'utf8'));
const decodedInlineTexts = assetTexts.flatMap((text) => {
  const matches = text.match(/data:[\w/+.;=-]*base64,[A-Za-z0-9+/=]+/g) ?? [];
  return matches.map((uri) => Buffer.from(uri.split('base64,')[1], 'base64').toString('utf8'));
});
const haystack = [...assetTexts, ...decodedInlineTexts].join('\n');
const assetMarkers = [
  ['zipformer2', 'the recognition worker chunk'],
  ["registerProcessor('voice-capture'", 'the AudioWorklet capture processor'],
];
for (const [marker, description] of assetMarkers) {
  if (!haystack.includes(marker)) {
    console.error(`[verify-prod-bundle] ${description} is missing from dist/assets (looked for ${marker})`);
    process.exit(1);
  }
}

console.log('[verify-prod-bundle] OK — no direct supabase.co / openrouter in dist');
