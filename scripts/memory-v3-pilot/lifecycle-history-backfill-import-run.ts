import { readFile } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isProxy } from 'node:util/types';
import { createClient } from '@supabase/supabase-js';

import {
  importReviewedLifecycleHistory,
  preflightReviewedLifecycleHistoryFiles,
  type LifecycleHistoryImportClient,
} from './lifecycle-history-backfill-import.ts';
import {
  createLifecycleHistorySupabaseReader,
  inspectLifecycleHistorySource,
  type LifecycleHistorySourceReader,
} from './lifecycle-history-backfill-source.ts';

type JsonRecord = Record<string, unknown>;

const PREFIX = '[memory-v3:lifecycle-history-backfill-import-run]';
const REQUIRED_FIELDS = [
  'argv', 'readFileImpl', 'readEnvText', 'createSourceReader', 'createImportClient',
  'writeStdout', 'writeStderr',
] as const;
type EnvName =
  | 'STAYSEE_MEMORY_V3_BACKFILL_USER_ID'
  | 'SUPABASE_URL'
  | 'SUPABASE_SERVICE_ROLE_KEY';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fail(): never {
  const error = new Error(`${PREFIX} run failed`);
  error.name = 'MemoryV3LifecycleHistoryBackfillImportRunError';
  throw error;
}

function safeKeys(value: object): PropertyKey[] {
  try {
    if (isProxy(value)) return fail();
    return Reflect.ownKeys(value);
  } catch {
    return fail();
  }
}

function safePrototype(value: object): object | null {
  try {
    if (isProxy(value)) return fail();
    return Object.getPrototypeOf(value);
  } catch {
    return fail();
  }
}

function dataValue(value: object, key: PropertyKey, enumerable: boolean): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== enumerable || !('value' in descriptor)) return fail();
    return descriptor.value;
  } catch {
    return fail();
  }
}

function inspectOptions(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || safePrototype(value) !== Object.prototype) return fail();
  const keys = safeKeys(value);
  if (keys.length !== REQUIRED_FIELDS.length || keys.some((key) =>
    typeof key !== 'string' || !REQUIRED_FIELDS.includes(key as typeof REQUIRED_FIELDS[number]))) {
    return fail();
  }
  const output: JsonRecord = Object.create(null);
  for (const field of REQUIRED_FIELDS) output[field] = dataValue(value, field, true);
  for (const field of REQUIRED_FIELDS.slice(1)) {
    if (typeof output[field] !== 'function' || isProxy(output[field] as object)) return fail();
  }
  return output;
}

function inspectArgv(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || isProxy(value) ||
    !Array.isArray(value) || safePrototype(value) !== Array.prototype) return fail();
  const length = dataValue(value, 'length', false);
  if (length !== 7 || safeKeys(value).length !== 8) return fail();
  const output: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const entry = dataValue(value, String(index), true);
    if (typeof entry !== 'string') return fail();
    output.push(entry);
  }
  return output;
}

function parseArgv(value: unknown): { artifactFile: string; reviewFile: string; importId: string } {
  const argv = inspectArgv(value);
  if (argv[0] !== '--import-reviewed-history') return fail();
  const allowed = new Set(['--artifact-file', '--review-file', '--import-id']);
  const fields = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const entry = argv[index + 1];
    if (!allowed.has(flag) || fields.has(flag) || entry === undefined) return fail();
    fields.set(flag, entry);
  }
  const artifactFile = fields.get('--artifact-file');
  const reviewFile = fields.get('--review-file');
  const importId = fields.get('--import-id');
  if (!artifactFile || !reviewFile || !importId ||
    !isAbsolute(artifactFile) || !isAbsolute(reviewFile) ||
    extname(artifactFile).toLowerCase() !== '.json' ||
    extname(reviewFile).toLowerCase() !== '.json' || !UUID.test(importId)) return fail();
  return { artifactFile, reviewFile, importId };
}

async function safeRead(
  readFileImpl: (path: string, encoding: 'utf8') => Promise<string>,
  path: string,
): Promise<string> {
  try {
    const text = await readFileImpl(path, 'utf8');
    if (typeof text !== 'string' || text.length === 0 || text.length > 10_000_000) return fail();
    return text;
  } catch {
    return fail();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail();
  }
}

async function readEnv(
  readEnvText: (name: string) => Promise<string>,
  name: EnvName,
): Promise<string> {
  try {
    const value = await readEnvText(name);
    if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return fail();
    return value;
  } catch {
    return fail();
  }
}

function failureText(): string {
  return `${JSON.stringify({ ok: false, stage: 'config', error: `${PREFIX} run failed` })}\n`;
}

function captureStderr(value: unknown): ((text: string) => void) | null {
  if (typeof value !== 'object' || value === null || isProxy(value)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'writeStderr');
    return descriptor && descriptor.enumerable && 'value' in descriptor &&
      typeof descriptor.value === 'function' && !isProxy(descriptor.value)
      ? descriptor.value as (text: string) => void
      : null;
  } catch {
    return null;
  }
}

export async function main(input: {
  argv: unknown;
  readFileImpl: (path: string, encoding: 'utf8') => Promise<string>;
  readEnvText: (name: string) => Promise<string>;
  createSourceReader: (url: string, serviceKey: string) => LifecycleHistorySourceReader;
  createImportClient: (url: string, serviceKey: string) => LifecycleHistoryImportClient;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}): Promise<number> {
  const stderr = captureStderr(input);
  try {
    const root = inspectOptions(input);
    const argv = parseArgv(root.argv);
    const artifactText = await safeRead(root.readFileImpl as typeof input.readFileImpl, argv.artifactFile);
    const reviewText = await safeRead(root.readFileImpl as typeof input.readFileImpl, argv.reviewFile);
    const artifact = parseJson(artifactText);
    const reviewDecision = parseJson(reviewText);
    const identity = preflightReviewedLifecycleHistoryFiles({ artifact, reviewDecision });

    const userId = await readEnv(root.readEnvText as typeof input.readEnvText,
      'STAYSEE_MEMORY_V3_BACKFILL_USER_ID');
    if (!UUID.test(userId) || userId !== identity.userId) return fail();
    const url = await readEnv(root.readEnvText as typeof input.readEnvText, 'SUPABASE_URL');
    const serviceKey = await readEnv(root.readEnvText as typeof input.readEnvText,
      'SUPABASE_SERVICE_ROLE_KEY');
    const reader = (root.createSourceReader as typeof input.createSourceReader)(url, serviceKey);
    const freshPreparedSource = await inspectLifecycleHistorySource({
      profileId: identity.profileId,
      userId,
      sourceCutoff: identity.sourceCutoff,
      reader,
    });
    const client = (root.createImportClient as typeof input.createImportClient)(url, serviceKey);
    const result = await importReviewedLifecycleHistory({
      artifact, reviewDecision, freshPreparedSource, userId, importId: argv.importId, client,
    });
    (root.writeStdout as (text: string) => void)(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    if (stderr) {
      try { stderr(failureText()); } catch { /* fixed best-effort diagnostic */ }
    }
    return 1;
  }
}

function createImportClient(url: string, serviceKey: string): LifecycleHistoryImportClient {
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async loadCurrentHead(userId: string) {
      const head = await client.from('memory_v3_lifecycle_shadow_heads')
        .select('state_revision').eq('user_id', userId).maybeSingle();
      if (head.error) return fail();
      const items = await client.from('memory_v3_lifecycle_shadow_items')
        .select('*', { count: 'exact', head: true }).eq('user_id', userId);
      if (items.error || !Number.isSafeInteger(items.count ?? 0)) return fail();
      const revision = head.data === null ? 0 : head.data.state_revision;
      return { stateRevision: revision, itemCount: items.count ?? 0 };
    },
    async importInitialState(importInput) {
      const response = await client.rpc('import_memory_v3_lifecycle_backfill_state', {
        p_import_id: importInput.importId,
        p_user_id: importInput.userId,
        p_expected_state_revision: importInput.expectedStateRevision,
        p_artifact_digest: importInput.artifactDigest,
        p_source_snapshot_digest: importInput.sourceSnapshotDigest,
        p_source_cutoff: importInput.sourceCutoff,
        p_profile_id: importInput.profileId,
        p_pipeline_version: importInput.pipelineVersion,
        p_extractor_version: importInput.extractorVersion,
        p_reconciler_version: importInput.reconcilerVersion,
        p_state: importInput.state,
      });
      if (response.error || !Array.isArray(response.data) || response.data.length !== 1) return fail();
      return {
        result: response.data[0]?.result,
        resultingStateRevision: Number(response.data[0]?.resulting_state_revision),
      };
    },
  };
}

async function direct(): Promise<void> {
  const exitCode = await main({
    argv: process.argv.slice(2),
    readFileImpl: (path, encoding) => readFile(path, encoding),
    readEnvText: async (name) => process.env[name] ?? '',
    createSourceReader: (url, serviceKey) => createLifecycleHistorySupabaseReader(
      createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
    ),
    createImportClient,
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void direct();
}
