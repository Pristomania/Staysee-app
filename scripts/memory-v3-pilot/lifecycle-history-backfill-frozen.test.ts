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
    '8487279F70337D6EF3FBE6519CD491C2592833850C9A1C6DEE182E17907E7BE5',
  'supabase/functions/_shared/memoryV3/lifecyclePrompt.ts':
    '10F3BD2656DA99610FCF20899DF57E02167FD532EBF2C56ED6873342AC742521',
  'supabase/functions/_shared/memoryV3/lifecycleReducer.ts':
    'C7ED099FB0EF6447162B8EF7C53F4A45BDC99CAA735337593BBFEF1FF4D2A493',
  'supabase/functions/_shared/memoryV3/transport.ts':
    '3B51D9FB962DC7EEABD0F3C62EC362D3F3D8DA916CFAA1760B9623F8AA95A4BB',
  'supabase/functions/_shared/memoryV3/lifecycleTransport.ts':
    '86064F2B59C1AADA614F7A20F2A928FA7D0AB6520F2F7CFEBB1AEE9B3AE7C1F0',
  'supabase/functions/_shared/memoryV3/messages.ts':
    'CAF019478CFEEBDB57692E5348FFB0EE6625C07F637A425111C3655F67DBB2BD',
  'supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql':
    '1BC7454D2140156ACEA1DE0F8FC89959D0590A26BC3E73BBDDC3774E5FE5AB21',
  'supabase/migrations/20260920010000_036_memory_v3_lifecycle_read_canary.sql':
    'A81C4C01C5059E3F259F5D141825404B4F00623D980EEA67B9751B20EB070099',
  'docs/superpowers/specs/2026-09-20-memory-v3-historical-backfill-design.md':
    'FC773260D68317DF4B863B76CD0B7E9383B963E2500BAD575E086636A958B9AD',
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

// Line endings are made the same before hashing: the files are committed with LF, and a Windows checkout
// (core.autocrlf) turns them into CRLF, which must not break this gate. Any other change still does.
function sha256(relativePath: string): string {
  const text = readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase();
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
    assert.equal(MEMORY_V3_LIFECYCLE_MAX_OUTPUT_TOKENS_PER_CALL, 4_000);
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
