/**
 * Run: npx tsx supabase/functions/_shared/ageConfirmationRecord.cases.test.ts
 * The tick "Подтверждаю, что мне исполнилось 18 лет" at registration is recorded in the database like the other
 * agreements (the offer, the data processing): which sentence (its SHA-256 and a version) and the server's time.
 * Before (11.11.2026) the tick only stopped the form; nothing remained to show the person had confirmed it.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { AGE_18_META, signUpConsentMetadata } from '../../../src/lib/consents.ts';
import { ROOM_COPY } from '../../../src/lib/roomCopy.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8').replace(/\r/g, '');

// ── what is recorded is the exact sentence the person ticked ─────────────────────────────────────────────
const hash = createHash('sha256').update(ROOM_COPY.age18Confirm, 'utf8').digest('hex');
assert(AGE_18_META.sha256 === hash, `the recorded hash is that of the sentence on the form (change the sentence: change the hash AND the version), expected ${hash}`);
assert(/^[0-9a-f]{64}$/.test(AGE_18_META.sha256) && AGE_18_META.version.length >= 1, 'a version and a 64-character hash');
assert(signUpConsentMetadata({
  terms: { version: '1.3', sha256: 'a'.repeat(64) },
  pd_processing: { version: '1.4', sha256: 'b'.repeat(64) },
  age_18: AGE_18_META,
}, 'ua').consents.age_18.sha256 === hash, 'the sign-up metadata carries it');

// ── the form sends it ────────────────────────────────────────────────────────────────────────────────────
const register = read('src/components/screens/RegisterScreen.tsx');
assert(/age_18:\s*AGE_18_META/.test(register), 'the registration form sends the 18+ confirmation');
assert(/confirmedAge18/.test(register) && /ROOM_COPY\.age18Required/.test(register), 'and still refuses to go on without the tick');

// ── the database records it ──────────────────────────────────────────────────────────────────────────────
const dir = new URL('../../migrations/', import.meta.url);
const file = readdirSync(dir).find((name) => /_094_age_confirmation_consent\.sql$/.test(name));
assert(file, 'migration 094 exists');
const sql = readFileSync(new URL(file, dir), 'utf8').replace(/\r/g, '');
assert(/CHECK \(consent_type IN \('terms', 'pd_processing', 'images', 'age_18'\)\)/.test(sql), 'the table accepts the new kind');
assert(/ARRAY\['terms', 'pd_processing', 'age_18'\]/.test(sql), 'the sign-up trigger writes it');
assert(/NOT IN \('terms', 'pd_processing', 'images', 'age_18'\)/.test(sql), 'record_user_consent accepts it too');
assert(/BEGIN\s+BEGIN/.test(sql.replace(/\n\s*/g, ' ')) || /EXCEPTION WHEN OTHERS THEN/.test(sql), 'a problem with the record still never stops a registration');
assert(!/\bDELETE\s+FROM\b|DROP\s+TABLE|TRUNCATE|\bUPDATE\s+public\./i.test(sql), 'no row is deleted or rewritten');

console.log('All ageConfirmationRecord cases passed.');
