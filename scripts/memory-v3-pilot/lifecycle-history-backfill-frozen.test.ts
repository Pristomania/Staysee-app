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
    '933194DDB51111A91E85030914A2112EA89347ECE5947D7FB7C5AE20ECF2B095',
  'supabase/functions/_shared/memoryV3/lifecyclePrompt.ts':
    '6BD99B0D71065612B1071B5D91D3C30C4071A3E1B3CF5074C7D3767B13DB6759',
  'supabase/functions/_shared/memoryV3/lifecycleReducer.ts':
    '99EE66F532C50B5245B5279299958687ADBD7B2079D61A8F817EE11F6D05B581',
  'supabase/functions/_shared/memoryV3/transport.ts':
    '4C549142FBDBA49BAAEAD76E1B162462095E545833407A853458505924398C6D',
  'supabase/functions/_shared/memoryV3/lifecycleTransport.ts':
    'D555A57FE81EBB6BA72DE3E6A801CFEFE4F782080BD9A23E4C3BEA0533270DEB',
  'supabase/functions/_shared/memoryV3/messages.ts':
    '77CCE382D809C51198703CD1A9A61F1D3DF4B1ADFB7CF60B5C74556FF73C24E4',
  'supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql':
    '6BAF2F0D95FF483DF488AB7CCC473366362C12475538C2AC0FFCE921A26A7334',
  'supabase/migrations/20260920010000_036_memory_v3_lifecycle_read_canary.sql':
    '0D2F680B52E536BED3372EECF18B3F5F740A47CE0EC2C1427461002D9AC9D385',
  'docs/superpowers/specs/2026-09-20-memory-v3-historical-backfill-design.md':
    '40412BAAE1A88B3E8C5D126188A3E68B7D950D10FB69C47CB7E8B3DC7594FE90',
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
