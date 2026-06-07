/**
 * Read-only: print staysee-chat BASE_PROMPT assembly and approximate token count.
 * Run: node scripts/audit-system-prompt.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shared = join(root, 'supabase/functions/_shared');

function load(name) {
  return readFileSync(join(shared, name), 'utf8');
}

function extractConst(name, src) {
  const m = src.match(new RegExp(`export const ${name}[\\s\\S]*?= \\[([\\s\\S]*?)\\] as const`, 'm'));
  if (!m) return '';
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^[\s"']+|["',]+$/g, '').trim())
    .filter(Boolean)
    .map((l) => `• ${l}`)
    .join('\n');
}

function extractTemplate(fnBody) {
  const m = fnBody.match(/`([\s\S]*?)`\.trim\(\)/);
  return m ? m[1].trim() : fnBody;
}

const identity = extractTemplate(load('identity.ts').match(/const CORE = `[\s\S]*?`\.trim\(\)/m)?.[0] ?? '');
const gestalt = extractTemplate(load('gestalt.ts').match(/const GESTALT = `[\s\S]*?`\.trim\(\)/m)?.[0] ?? '');
const methodology = extractTemplate(load('methodology.ts').match(/const METHODOLOGY = `[\s\S]*?`\.trim\(\)/m)?.[0] ?? '');
const safety = extractTemplate(load('safety.ts').match(/return `\n([\s\S]*?)`\.trim\(\)/m)?.[0] ?? '');
const presence = extractTemplate(load('presence.ts').match(/const PRESENCE = `[\s\S]*?`\.trim\(\)/m)?.[0] ?? '');

const constitutionSrc = load('constitution.ts');
const mission = extractTemplate(constitutionSrc.match(/export const STAYSY_MISSION = `[\s\S]*?`\.trim\(\)/m)?.[0] ?? '');
const principles = extractConst('STAYSY_CONSTITUTION_PRINCIPLES', constitutionSrc);
const attention = extractConst('STAYSY_ATTENTION_PRINCIPLES', constitutionSrc);
const constitution = [
  mission,
  'КОНСТИТУЦИЯ STAYSEE (внутреннее, не цитировать пользователю):',
  principles,
  'ПРИНЦИПЫ ВНИМАНИЯ (внутреннее):',
  attention,
].join('\n\n');

const BASE_PROMPT = [identity, gestalt, methodology, safety, constitution, presence].join('\n\n');
const approxTokens = Math.ceil(BASE_PROMPT.length / 3.5);

const layers = [
  ['L2 identity.ts', identity],
  ['L gestalt.ts', gestalt],
  ['L3 methodology.ts', methodology],
  ['L5 safety.ts', safety],
  ['L1 constitution.ts', constitution],
  ['L8 presence.ts', presence],
];

console.log('=== staysee-chat BASE_PROMPT assembly ===\n');
console.log('File: supabase/functions/staysee-chat/index.ts');
console.log('BASE_PROMPT = join in order:\n  1. buildIdentityPrompt()');
console.log('  2. buildGestaltPrompt()');
console.log('  3. buildMethodologyPrompt()');
console.log('  4. buildSafetyPrompt()');
console.log('  5. buildConstitutionPrompt()');
console.log('  6. buildPresencePrompt()\n');
console.log('Per-turn additions (same file):');
console.log('  + buildContextPrompt(packet)     — memory, summary, archive');
console.log('  + buildRecallGroundingPrompt()   — if recall intent');
console.log('  + buildMemoryContinuityPrompt()  — if stale summary / long pause');
console.log('  + safety.systemGuidance            — per safety category');
console.log('  + buildTimeGapPrompt()           — client pause metadata');
console.log('  + stance.systemGuidance          — evaluateStance()\n');

for (const [label, text] of layers) {
  console.log(`--- ${label} (${text.length} chars, ~${Math.ceil(text.length / 3.5)} tok) ---`);
  console.log(text.slice(0, 400) + (text.length > 400 ? '\n...[truncated]...\n' : '\n'));
}

console.log(`=== BASE_PROMPT total: ${BASE_PROMPT.length} chars, ~${approxTokens} tokens ===\n`);
console.log('Model call: callModel(..., systemPrompt, ...) → OpenRouter messages[0].role=system');
console.log('Post-process: mergeContinuationWithoutOverlap + polishMergedReply + ensurePublishableReply');
