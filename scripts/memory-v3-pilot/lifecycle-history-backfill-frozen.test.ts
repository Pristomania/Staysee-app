import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MEMORY_V3_LIFECYCLE_MAX_EXTRACTOR_BYTES,
  MEMORY_V3_LIFECYCLE_MAX_MODEL_CALLS_PER_RUN,
  MEMORY_V3_LIFECYCLE_MAX_OUTPUT_TOKENS_PER_CALL,
  MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES,
  MEMORY_V3_LIFECYCLE_MAX_SOURCE_MESSAGES,
  MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE,
  MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS,
  MEMORY_V3_LIFECYCLE_RESERVED_INPUT_TOKENS_PER_CALL,
} from '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const EXPECTED_SHA256 = Object.freeze({
  'supabase/functions/_shared/memoryV3/lifecycleContract.ts':
    'ECE40C7EAE6DD806D84EA223DB7FB850452C241040CAFC235809B70BCF6779B2',
  'supabase/functions/_shared/memoryV3/lifecyclePrompt.ts':
    '80247FD956861A5D8440E6217962DAFF15B9593A7A9E237BD56E9F7869EFE841',
  'supabase/functions/_shared/memoryV3/lifecycleReducer.ts':
    '071C9914B374ECC0461B6C49E0D85C00C8141AB3C7AE24AE960EDBADD6A6461A',
  'supabase/functions/_shared/memoryV3/transport.ts':
    '8FA07F500CE2E20A736549CF05B4BC1B274C8F1AC477B24C8EE6389069FAC567',
  'supabase/functions/_shared/memoryV3/lifecycleTransport.ts':
    'B298AE34C15CD6FBE83138CA353D28ABCD56FA220D918FDD15A824A4BD70F126',
  'supabase/functions/_shared/memoryV3/messages.ts':
    '46A3189C840082F52A8FEEC662F35D4FFE571B39D6FE8E5292C872FC0A01FF73',
  'supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql':
    '1BC7454D2140156ACEA1DE0F8FC89959D0590A26BC3E73BBDDC3774E5FE5AB21',
  'supabase/migrations/20260920010000_036_memory_v3_lifecycle_read_canary.sql':
    'A81C4C01C5059E3F259F5D141825404B4F00623D980EEA67B9751B20EB070099',
  'docs/superpowers/specs/2026-09-20-memory-v3-historical-backfill-design.md':
    '8A77338C51E853882AAC5DE9741918502314D87E2AAC735D1C141DA81C9E0758',
});

const EXPECTED_IMPORTS = Object.freeze([
  'node:assert/strict',
  'node:crypto',
  'node:fs',
  'node:path',
  'node:test',
  'node:url',
  '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts',
]);

function sha256(relativePath: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(REPOSITORY_ROOT, relativePath)))
    .digest('hex')
    .toUpperCase();
}

function sourceImportSpecifiers(source: string): string[] {
  return Array.from(
    source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
    (match) => match[1],
  );
}

describe('Memory V3 historical backfill frozen baseline', () => {
  it('locks the exact reviewed lifecycle source bytes', () => {
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(EXPECTED_SHA256).map((relativePath) => [
          relativePath,
          sha256(relativePath),
        ]),
      ),
      EXPECTED_SHA256,
    );
  });

  it('locks the lifecycle limits required by the backfill design', () => {
    assert.equal(MEMORY_V3_LIFECYCLE_MAX_SOURCE_MESSAGES, 60);
    assert.equal(MEMORY_V3_LIFECYCLE_MAX_EXTRACTOR_BYTES, 20_000);
    assert.equal(MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES, 80_000);
    assert.equal(
      MEMORY_V3_LIFECYCLE_RESERVED_INPUT_TOKENS_PER_CALL,
      32_768,
    );
    assert.equal(MEMORY_V3_LIFECYCLE_MAX_OUTPUT_TOKENS_PER_CALL, 1_200);
    assert.equal(MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS, 100);
    assert.equal(MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE, 500);
    assert.equal(MEMORY_V3_LIFECYCLE_MAX_MODEL_CALLS_PER_RUN, 2);
  });

  it('reads only source files and the frozen lifecycle contract', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    assert.deepEqual(sourceImportSpecifiers(source), EXPECTED_IMPORTS);
    assert.doesNotMatch(source, /\bimport\s*\(/u);
  });
});
