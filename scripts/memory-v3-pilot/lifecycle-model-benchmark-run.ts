/** Import-safe composition root for the synthetic lifecycle model benchmark. */

import { access, link, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runLifecycleModelBenchmarkFromArgv } from './lifecycle-model-benchmark-cli.ts';

type JsonRecord = Record<string, unknown>;

const PREFIX = '[memory-v3:lifecycle-model-benchmark-run]';
const DATASET_PATH = fileURLToPath(
  new URL('./memory-v3-synthetic-lifecycle.v1.json', import.meta.url),
);
const REQUIRED_FIELDS = [
  'argv', 'readFileImpl', 'fetchImpl', 'writeStdout', 'writeStderr',
] as const;
const OPTIONAL_FIELDS = ['accessImpl', 'writeFileImpl', 'linkImpl', 'unlinkImpl'] as const;
const ALLOWED_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS] as const;

function fail(): never {
  const error = new Error(`${PREFIX} run failed`);
  error.name = 'MemoryV3LifecycleModelBenchmarkRunError';
  throw error;
}

function safePrototype(value: object): object | null {
  try {
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

function safeDescriptor(value: object, key: PropertyKey): PropertyDescriptor {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return fail();
    return descriptor;
  } catch {
    return fail();
  }
}

function dataValue(value: object, key: PropertyKey, enumerable: boolean): unknown {
  const descriptor = safeDescriptor(value, key);
  if (!('value' in descriptor) || descriptor.enumerable !== enumerable) return fail();
  return descriptor.value;
}

function inspectOptions(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null) return fail();
  const prototype = safePrototype(value);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const keys = safeKeys(value);
  if (keys.some((key) =>
    typeof key !== 'string' || !ALLOWED_FIELDS.includes(key as typeof ALLOWED_FIELDS[number]))) {
    return fail();
  }
  for (const field of REQUIRED_FIELDS) {
    if (!keys.includes(field)) return fail();
  }
  const result: JsonRecord = {};
  for (const key of keys) {
    result[key as string] = dataValue(value, key, true);
  }
  return result;
}

function inspectArgv(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return fail();
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    return fail();
  }
  if (!isArray || safePrototype(value) !== Array.prototype) return fail();
  const lengthValue = dataValue(value, 'length', false);
  if (!Number.isSafeInteger(lengthValue) || (lengthValue as number) < 0) return fail();
  const length = lengthValue as number;
  const keys = safeKeys(value);
  if (keys.length !== length + 1) return fail();
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = dataValue(value, String(index), true);
    if (typeof item !== 'string') return fail();
    result.push(item);
  }
  if (keys.some((key) => {
    if (key === 'length') return false;
    return typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length;
  })) return fail();
  return result;
}

function parseRunArgv(value: unknown): {
  forwarded: string[];
  execute: boolean;
  outputFile?: string;
} {
  const argv = inspectArgv(value);
  const execute = argv.includes('--execute-twelve-paid-requests');
  const outputIndex = argv.indexOf('--safe-output-file');
  if (outputIndex === -1) return { forwarded: argv, execute };
  if (!execute || outputIndex !== argv.length - 2 ||
    argv.lastIndexOf('--safe-output-file') !== outputIndex) return fail();
  const outputFile = argv[outputIndex + 1];
  if (typeof outputFile !== 'string' || outputFile.trim() !== outputFile ||
    outputFile.length === 0 || !isAbsolute(outputFile) || extname(outputFile).toLowerCase() !== '.json') {
    return fail();
  }
  return { forwarded: argv.slice(0, outputIndex), execute, outputFile };
}

function isEnoent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(error);
    keys = Reflect.ownKeys(error);
  } catch {
    return false;
  }
  if (prototype !== Error.prototype && !(error instanceof Error)) return false;
  if (!keys.includes('code')) return false;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  } catch {
    return false;
  }
  return Boolean(descriptor && 'value' in descriptor && descriptor.enumerable === true &&
    descriptor.value === 'ENOENT');
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

async function loadDataset(readFileImpl: (path: string, encoding: 'utf8') => Promise<string>) {
  let text: unknown;
  try {
    text = await readFileImpl(DATASET_PATH, 'utf8');
  } catch {
    return fail();
  }
  if (typeof text !== 'string') return fail();
  try {
    return JSON.parse(text);
  } catch {
    return fail();
  }
}

function serialize(value: unknown): string {
  try {
    return `${JSON.stringify(value)}\n`;
  } catch {
    return fail();
  }
}

async function safeWrite(writer: unknown, text: string): Promise<void> {
  if (typeof writer !== 'function') return fail();
  try {
    await writer(text);
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
  const temporaryPath = `${outputFile}.tmp`;
  let tempCreated = false;
  try {
    await writeFileImpl(temporaryPath, text, { flag: 'wx' });
    tempCreated = true;
  } catch {
    return fail();
  }
  try {
    await linkImpl(temporaryPath, outputFile);
  } catch {
    if (tempCreated) {
      try {
        await unlinkImpl(temporaryPath);
      } catch {
        // Cleanup is best-effort and is never retried when ownership becomes uncertain.
      }
    }
    return fail();
  }
  try {
    await unlinkImpl(temporaryPath);
    tempCreated = false;
  } catch {
    return fail();
  }
}

function failureText(): string {
  return serialize({ ok: false, stage: 'config', error: `${PREFIX} run failed` });
}

export async function main(options: {
  argv: unknown;
  readFileImpl: (path: string, encoding: 'utf8') => Promise<string>;
  accessImpl: (path: string) => Promise<void>;
  writeFileImpl: (path: string, data: string, options: { flag: 'wx' }) => Promise<void>;
  linkImpl: (existingPath: string, newPath: string) => Promise<void>;
  unlinkImpl: (path: string) => Promise<void>;
  fetchImpl: typeof fetch;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}): Promise<number> {
  let stderr: unknown;
  try {
    const root = inspectOptions(options);
    stderr = root.writeStderr;
    for (const field of ['readFileImpl', 'fetchImpl', 'writeStdout', 'writeStderr']) {
      if (typeof root[field] !== 'function') return fail();
    }
    const parsed = parseRunArgv(root.argv);
    if (parsed.outputFile !== undefined) {
      for (const field of OPTIONAL_FIELDS) {
        if (typeof root[field] !== 'function') return fail();
      }
      await assertAbsent(root.accessImpl as (path: string) => Promise<void>, parsed.outputFile);
      await assertAbsent(root.accessImpl as (path: string) => Promise<void>, `${parsed.outputFile}.tmp`);
    }

    const dataset = await loadDataset(
      root.readFileImpl as (path: string, encoding: 'utf8') => Promise<string>,
    );
    const readEnvText = async (path: string) => {
      let text: unknown;
      try {
        text = await (root.readFileImpl as
          (path: string, encoding: 'utf8') => Promise<string>)(path, 'utf8');
      } catch {
        return fail();
      }
      if (typeof text !== 'string') return fail();
      return text;
    };
    const payload = await runLifecycleModelBenchmarkFromArgv({
      argv: parsed.forwarded,
      dataset,
      fetchImpl: root.fetchImpl as typeof fetch,
      readEnvText,
    });
    const text = serialize({
      benchmarkResult: payload.benchmarkResult,
      semanticReviewPacket: null,
    });
    if (parsed.outputFile !== undefined) {
      await publish(
        parsed.outputFile,
        text,
        root.writeFileImpl as
          (path: string, data: string, options: { flag: 'wx' }) => Promise<void>,
        root.linkImpl as (existingPath: string, newPath: string) => Promise<void>,
        root.unlinkImpl as (path: string) => Promise<void>,
      );
    }
    await safeWrite(root.writeStdout, text);
    return 0;
  } catch {
    if (typeof stderr === 'function') {
      try {
        await stderr(failureText());
      } catch {
        // Stderr failure must not expose the original error.
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
  const exitCode = await main({
    argv: process.argv.slice(2),
    readFileImpl: (path, encoding) => readFile(path, encoding),
    accessImpl: access,
    writeFileImpl: (path, data, options) => writeFile(path, data, options),
    linkImpl: link,
    unlinkImpl: unlink,
    fetchImpl: globalThis.fetch.bind(globalThis),
    writeStdout: (text) => { process.stdout.write(text); },
    writeStderr: (text) => { process.stderr.write(text); },
  });
  process.exitCode = exitCode;
}

if (isDirectInvocation()) await runDirect();
