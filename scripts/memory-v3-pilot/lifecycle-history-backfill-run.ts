/** Import-safe filesystem and process composition root for historical backfill. */

import { access, link, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isProxy } from 'node:util/types';
import { createClient } from '@supabase/supabase-js';

import { runLifecycleHistoryBackfillFromArgv } from './lifecycle-history-backfill-cli.ts';
import {
  createLifecycleHistorySupabaseReader,
  type LifecycleHistorySourceReader,
} from './lifecycle-history-backfill-source.ts';

type JsonRecord = Record<string, unknown>;

const PREFIX = '[memory-v3:lifecycle-history-backfill-run]';
const ERROR_NAME = 'MemoryV3LifecycleHistoryBackfillRunError';
const ENV_NAMES = new Set([
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STAYSEE_MEMORY_V3_BACKFILL_USER_ID',
  'OPENROUTER_API_KEY',
]);
const REQUIRED_FIELDS = [
  'argv', 'readFileImpl', 'accessImpl', 'writeFileImpl', 'linkImpl', 'unlinkImpl',
  'createSourceReader', 'fetchImpl', 'nowMs', 'writeStdout', 'writeStderr',
] as const;

function fail(): never {
  const error = new Error(`${PREFIX} run failed`);
  error.name = ERROR_NAME;
  throw error;
}

function safePrototype(value: object): object | null {
  try {
    if (isProxy(value)) return fail();
    return Object.getPrototypeOf(value);
  } catch {
    return fail();
  }
}

function safeKeys(value: object): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return fail();
  }
}

function dataValue(value: object, key: PropertyKey, enumerable: boolean): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return fail();
  }
  if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== enumerable) {
    return fail();
  }
  return descriptor.value;
}

function inspectOptions(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || safePrototype(value) !== Object.prototype) {
    return fail();
  }
  const keys = safeKeys(value);
  if (keys.length !== REQUIRED_FIELDS.length || keys.some((key) =>
    typeof key !== 'string' || !REQUIRED_FIELDS.includes(key as typeof REQUIRED_FIELDS[number]))) {
    return fail();
  }
  const projected: JsonRecord = Object.create(null);
  for (const field of REQUIRED_FIELDS) projected[field] = dataValue(value, field, true);
  for (const field of REQUIRED_FIELDS.slice(1).filter((field) => field !== 'nowMs')) {
    if (typeof projected[field] !== 'function' || isProxy(projected[field] as object)) return fail();
  }
  if (!Number.isSafeInteger(projected.nowMs)) return fail();
  return projected;
}

function captureWriteStderr(value: unknown): ((text: string) => void) | null {
  if (typeof value !== 'object' || value === null) return null;
  try {
    if (isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'writeStderr');
    if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor) ||
      typeof descriptor.value !== 'function' || isProxy(descriptor.value)) return null;
    return descriptor.value as (text: string) => void;
  } catch {
    return null;
  }
}

function inspectArgv(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return fail();
  let array = false;
  try {
    if (isProxy(value)) return fail();
    array = Array.isArray(value);
  } catch {
    return fail();
  }
  if (!array || safePrototype(value) !== Array.prototype) return fail();
  const lengthValue = dataValue(value, 'length', false);
  if (!Number.isSafeInteger(lengthValue) || (lengthValue as number) < 0) return fail();
  const length = lengthValue as number;
  const keys = safeKeys(value);
  if (keys.length !== length + 1) return fail();
  const entries: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = dataValue(value, String(index), true);
    if (typeof item !== 'string') return fail();
    entries.push(item);
  }
  if (keys.some((key) => key !== 'length' &&
    (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length))) {
    return fail();
  }
  return entries;
}

function parseRunArgv(value: unknown): {
  argv: string[];
  execute: boolean;
  outputFile: string | null;
} {
  const argv = inspectArgv(value);
  const execute = argv[0] === '--execute-history-backfill-paid-requests';
  const indexes = argv.flatMap((entry, index) => entry === '--safe-output-file' ? [index] : []);
  if (!execute) {
    if (indexes.length !== 0) return fail();
    return { argv, execute: false, outputFile: null };
  }
  if (indexes.length !== 1 || indexes[0] !== argv.length - 2) return fail();
  const outputFile = argv[indexes[0] + 1];
  if (!isAbsolute(outputFile) || outputFile.trim() !== outputFile ||
    extname(outputFile).toLowerCase() !== '.json') return fail();
  return { argv, execute: true, outputFile };
}

function isEnoent(error: unknown): boolean {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return false;
  try {
    if (isProxy(error)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return Boolean(descriptor && 'value' in descriptor && descriptor.enumerable === true &&
      descriptor.value === 'ENOENT');
  } catch {
    return false;
  }
}

async function assertAbsent(accessImpl: (path: string) => Promise<void>, path: string) {
  try {
    await accessImpl(path);
  } catch (error) {
    if (isEnoent(error)) return;
    return fail();
  }
  return fail();
}

function parseEnvValue(text: unknown, requestedName: string): string {
  if (typeof text !== 'string' || !ENV_NAMES.has(requestedName)) return fail();
  let found: string | undefined;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '' || /^\s*#/u.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) return fail();
    let value = match[2].trim();
    const startsDouble = value.startsWith('"');
    const endsDouble = value.endsWith('"');
    const startsSingle = value.startsWith("'");
    const endsSingle = value.endsWith("'");
    if (startsDouble || endsDouble || startsSingle || endsSingle) {
      if (value.length < 2 || !((startsDouble && endsDouble) || (startsSingle && endsSingle))) {
        return fail();
      }
      value = value.slice(1, -1);
    }
    if (match[1] === requestedName) {
      if (found !== undefined) return fail();
      found = value;
    }
  }
  if (found === undefined) return fail();
  return found;
}

async function safeRead(
  readFileImpl: (path: string, encoding: 'utf8') => Promise<string>,
  path: string,
): Promise<string> {
  let value: unknown;
  try {
    value = await readFileImpl(path, 'utf8');
  } catch {
    return fail();
  }
  if (typeof value !== 'string') return fail();
  return value;
}

function serialize(value: unknown): string {
  try {
    return `${JSON.stringify(value)}\n`;
  } catch {
    return fail();
  }
}

async function publish(
  outputFile: string,
  text: string,
  writeFileImpl: (path: string, data: string, options: { flag: 'wx' }) => Promise<void>,
  linkImpl: (existingPath: string, newPath: string) => Promise<void>,
  unlinkImpl: (path: string) => Promise<void>,
) {
  const temp = `${outputFile}.tmp`;
  let tempCreated = false;
  try {
    await writeFileImpl(temp, text, { flag: 'wx' });
    tempCreated = true;
  } catch {
    return fail();
  }
  try {
    await linkImpl(temp, outputFile);
  } catch {
    if (tempCreated) {
      try {
        await unlinkImpl(temp);
      } catch {
        // Cleanup is best-effort and never retried.
      }
    }
    return fail();
  }
  try {
    await unlinkImpl(temp);
    tempCreated = false;
  } catch {
    return fail();
  }
}

function projectSummary(
  payload: Awaited<ReturnType<typeof runLifecycleHistoryBackfillFromArgv>>,
  outputWritten: boolean,
): Record<string, unknown> {
  const result = payload.benchmarkResult;
  const items = result.finalState?.items ?? [];
  return {
    status: result.execute ? 'completed' : 'inspected',
    profileId: result.profileId,
    sourceSnapshotDigest: result.manifest.sourceSnapshotDigest,
    chunkCount: result.manifest.chunkCount,
    itemCount: items.length,
    evidenceCount: items.reduce((sum, item) => sum + item.evidence.length, 0),
    payloadSha256: payload.semanticReviewPacket?.payloadSha256 ?? null,
    outputWritten,
  };
}

function failureText(): string {
  return `${JSON.stringify({ ok: false, stage: 'config', error: `${PREFIX} run failed` })}\n`;
}

export async function main(input: {
  argv: unknown;
  readFileImpl: (path: string, encoding: 'utf8') => Promise<string>;
  accessImpl: (path: string) => Promise<void>;
  writeFileImpl: (path: string, data: string, options: { flag: 'wx' }) => Promise<void>;
  linkImpl: (existingPath: string, newPath: string) => Promise<void>;
  unlinkImpl: (path: string) => Promise<void>;
  createSourceReader: (url: string, serviceKey: string) => LifecycleHistorySourceReader;
  fetchImpl: typeof fetch;
  nowMs: number;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}): Promise<number> {
  const stderr = captureWriteStderr(input);
  try {
    const root = inspectOptions(input);
    const parsed = parseRunArgv(root.argv);
    if (parsed.outputFile !== null) {
      await assertAbsent(root.accessImpl as (path: string) => Promise<void>, parsed.outputFile);
      await assertAbsent(root.accessImpl as (path: string) => Promise<void>, `${parsed.outputFile}.tmp`);
    }

    const readEnvText = async (selector: string): Promise<string> => {
      const text = await safeRead(
        root.readFileImpl as (path: string, encoding: 'utf8') => Promise<string>,
        selector,
      );
      return ENV_NAMES.has(selector) ? parseEnvValue(text, selector) : text;
    };
    const payload = await runLifecycleHistoryBackfillFromArgv({
      argv: parsed.argv,
      sourceReader: root.createSourceReader,
      readEnvText,
      fetchImpl: root.fetchImpl as typeof fetch,
      nowMs: root.nowMs as number,
    });
    if (parsed.outputFile !== null) {
      await publish(
        parsed.outputFile,
        serialize(payload),
        root.writeFileImpl as
          (path: string, data: string, options: { flag: 'wx' }) => Promise<void>,
        root.linkImpl as (existingPath: string, newPath: string) => Promise<void>,
        root.unlinkImpl as (path: string) => Promise<void>,
      );
    }
    await (root.writeStdout as (text: string) => void)(
      serialize(projectSummary(payload, parsed.outputFile !== null)),
    );
    return 0;
  } catch {
    if (typeof stderr === 'function') {
      try {
        await (stderr as (text: string) => void)(failureText());
      } catch {
        // Public stderr remains best-effort and fixed.
      }
    }
    return 1;
  }
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

async function runDirect() {
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
  let envTextPromise: Promise<string> | null = null;
  const exitCode = await main({
    argv: process.argv.slice(2),
    readFileImpl: (path, encoding) => {
      if (!ENV_NAMES.has(path)) return readFile(path, encoding);
      envTextPromise ??= readFile(envPath, encoding);
      return envTextPromise;
    },
    accessImpl: access,
    writeFileImpl: (path, data, options) => writeFile(path, data, options),
    linkImpl: link,
    unlinkImpl: unlink,
    createSourceReader: (url, serviceKey) => createLifecycleHistorySupabaseReader(
      createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
    ),
    fetchImpl: globalThis.fetch.bind(globalThis),
    nowMs: Date.now(),
    writeStdout: (text) => { process.stdout.write(text); },
    writeStderr: (text) => { process.stderr.write(text); },
  });
  process.exitCode = exitCode;
}

if (isDirectInvocation()) await runDirect();
