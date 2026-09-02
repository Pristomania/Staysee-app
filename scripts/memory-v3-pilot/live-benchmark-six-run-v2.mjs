/**
 * Memory V3 V2 six-case live-benchmark composition root.
 * Injected IO in tests. Direct execution supplies production defaults.
 * No environment object, dotenv, extra fetch, or filesystem results file unless opted in.
 */

import { access, link, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSixCaseSemanticReviewPacketV2 } from './live-benchmark-six-v2.mjs';
import { runSixCaseBenchmarkFromArgvV2 } from './live-benchmark-six-cli-v2.mjs';

const GOLDEN_DATASET_URL = new URL('./memory-v3-ru-golden.v2.json', import.meta.url);
const OWN_ERRORS = new WeakSet();
const OPTION_REQUIRED = Object.freeze([
  'argv',
  'readFileImpl',
  'fetchImpl',
  'writeStdout',
  'writeStderr',
]);
const OPTION_OPTIONAL = Object.freeze([
  'writeFileImpl',
  'linkImpl',
  'unlinkImpl',
  'accessImpl',
]);

function fail(message) {
  const error = new Error(`[memory-v3:live-benchmark-six-run-v2] ${message}`);
  error.name = 'MemoryV3SixCaseBenchmarkRunV2Error';
  OWN_ERRORS.add(error);
  return error;
}

function isOwnError(error) {
  return (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    OWN_ERRORS.has(error)
  );
}

function inspectPlainObject(value, path) {
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    throw fail(`${path} must be a plain object`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(`${path} must be a plain object`);
  }
  if (proto !== Object.prototype && proto !== null) {
    throw fail(`${path} must be a plain object`);
  }
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw fail(`${path} has an invalid shape`);
  }
}

function dataDescriptor(value, key, path) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw fail(`${path} has an invalid shape`);
  }
  if (
    !desc ||
    typeof desc.get === 'function' ||
    typeof desc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(desc, 'value') ||
    desc.enumerable !== true
  ) {
    throw fail(`${path} has an invalid field`);
  }
  return desc;
}

function inspectRecordPartial(value, required, optional, path) {
  const keys = inspectPlainObject(value, path);
  const allowedSet = new Set([...required, ...optional]);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowedSet.has(key)) {
      throw fail(`${path} has an unknown field`);
    }
    const desc = dataDescriptor(value, key, path);
    if (desc.value === undefined) {
      throw fail(`${path} is missing a required field`);
    }
    copy[key] = desc.value;
  }
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail(`${path} is missing a required field`);
    }
  }
  return copy;
}

function inspectDenseArray(value, path) {
  if (!Array.isArray(value)) {
    throw fail(`${path} must be a dense array`);
  }
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw fail(`${path} must be a dense array`);
  }
  const length = value.length;
  const allowed = new Set(['length']);
  for (let i = 0; i < length; i += 1) allowed.add(String(i));
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      throw fail(`${path} has an invalid field`);
    }
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw fail(`${path} has an invalid field`);
    }
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value')
    ) {
      throw fail(`${path} has an invalid field`);
    }
    if (key !== 'length' && desc.enumerable !== true) {
      throw fail(`${path} has an invalid field`);
    }
  }
  const entries = [];
  for (let i = 0; i < length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(value, i);
    if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
      throw fail(`${path} must be a dense array`);
    }
    entries.push(desc.value);
  }
  return entries;
}

function hasExecuteFlag(argv) {
  const entries = inspectDenseArray(argv, 'argv');
  return entries.some((entry) => entry === '--execute-six-paid-requests');
}

function isAbsoluteJsonPath(value) {
  return typeof value === 'string' && isAbsolute(value) && extname(value) === '.json';
}

function parseSafeOutputFile(argv) {
  const entries = inspectDenseArray(argv, 'argv');
  const forwarded = [];
  let outputFile;
  for (let index = 0; index < entries.length; index += 1) {
    const arg = entries[index];
    if (arg === '--safe-output-file') {
      if (outputFile !== undefined) {
        throw fail('argument is duplicated');
      }
      const value = entries[index + 1];
      if (!isAbsoluteJsonPath(value)) {
        throw fail('safe-output-file is invalid');
      }
      outputFile = value;
      index += 1;
      continue;
    }
    forwarded.push(arg);
  }
  return { forwarded, outputFile };
}

function serializePayload(payload) {
  return `${JSON.stringify(payload)}\n`;
}

function writeSafe(writer, payload) {
  if (typeof writer !== 'function') {
    throw fail('writer must be a function');
  }
  const text = serializePayload(payload);
  writer(text);
  return text;
}

function publicFailure(message) {
  return {
    ok: false,
    stage: 'config',
    error: message,
  };
}

function ownDataValue(value, key) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return { ok: false };
  }
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return { ok: false };
  }
  if (
    !desc ||
    typeof desc.get === 'function' ||
    typeof desc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(desc, 'value') ||
    desc.enumerable !== true
  ) {
    return { ok: false };
  }
  return { ok: true, value: desc.value };
}

function isEnoentError(error) {
  const code = ownDataValue(error, 'code');
  return code.ok && code.value === 'ENOENT';
}

async function assertSafeOutputAbsent(accessImpl, outputFile) {
  if (typeof accessImpl !== 'function') {
    throw fail('accessImpl must be a function');
  }
  try {
    await accessImpl(outputFile);
  } catch (error) {
    if (isOwnError(error)) throw error;
    if (isEnoentError(error)) return;
    throw fail('output file cannot be used');
  }
  throw fail('output file already exists');
}

async function writeSafeOutputFile(inspected, outputFile, text) {
  if (typeof inspected.writeFileImpl !== 'function') {
    throw fail('writeFileImpl must be a function');
  }
  if (typeof inspected.linkImpl !== 'function') {
    throw fail('linkImpl must be a function');
  }
  if (typeof inspected.unlinkImpl !== 'function') {
    throw fail('unlinkImpl must be a function');
  }
  const temporaryPath = `${outputFile}.tmp`;
  let tempCreated = false;
  try {
    await inspected.writeFileImpl(temporaryPath, text, { encoding: 'utf8', flag: 'wx' });
    tempCreated = true;
    await inspected.linkImpl(temporaryPath, outputFile);
    await inspected.unlinkImpl(temporaryPath);
  } catch (error) {
    if (tempCreated) {
      try {
        await inspected.unlinkImpl(temporaryPath);
      } catch {
        // leftover temp cleanup must not leak the original error.
      }
    }
    if (isOwnError(error)) throw error;
    throw fail('output file cannot be written');
  }
}

async function loadGoldenDataset(readFileImpl) {
  let text;
  try {
    text = await readFileImpl(GOLDEN_DATASET_URL, 'utf8');
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('dataset cannot be read');
  }
  if (typeof text !== 'string') {
    throw fail('dataset is invalid');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw fail('dataset is invalid');
  }
}

export async function main(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw fail('options must be a plain object');
  }
  const inspected = inspectRecordPartial(options, OPTION_REQUIRED, OPTION_OPTIONAL, 'options');
  if (typeof inspected.readFileImpl !== 'function') {
    throw fail('readFileImpl must be a function');
  }
  if (typeof inspected.fetchImpl !== 'function') {
    throw fail('fetchImpl must be a function');
  }
  if (typeof inspected.writeStdout !== 'function' || typeof inspected.writeStderr !== 'function') {
    throw fail('stdio writers must be functions');
  }
  if (inspected.writeFileImpl !== undefined && typeof inspected.writeFileImpl !== 'function') {
    throw fail('writeFileImpl must be a function');
  }
  if (inspected.linkImpl !== undefined && typeof inspected.linkImpl !== 'function') {
    throw fail('linkImpl must be a function');
  }
  if (inspected.unlinkImpl !== undefined && typeof inspected.unlinkImpl !== 'function') {
    throw fail('unlinkImpl must be a function');
  }
  if (inspected.accessImpl !== undefined && typeof inspected.accessImpl !== 'function') {
    throw fail('accessImpl must be a function');
  }

  try {
    const parsedArgv = parseSafeOutputFile(inspected.argv);
    const execute = hasExecuteFlag(parsedArgv.forwarded);
    if (parsedArgv.outputFile !== undefined && !execute) {
      throw fail('safe-output-file requires execute');
    }
    if (parsedArgv.outputFile !== undefined) {
      if (typeof inspected.accessImpl !== 'function') {
        throw fail('accessImpl must be a function');
      }
      if (typeof inspected.writeFileImpl !== 'function') {
        throw fail('writeFileImpl must be a function');
      }
      if (typeof inspected.linkImpl !== 'function') {
        throw fail('linkImpl must be a function');
      }
      if (typeof inspected.unlinkImpl !== 'function') {
        throw fail('unlinkImpl must be a function');
      }
      const temporaryPath = `${parsedArgv.outputFile}.tmp`;
      await assertSafeOutputAbsent(inspected.accessImpl, parsedArgv.outputFile);
      await assertSafeOutputAbsent(inspected.accessImpl, temporaryPath);
    }
    const dataset = await loadGoldenDataset(inspected.readFileImpl);
    const readEnvText = async (path) => {
      try {
        const text = await inspected.readFileImpl(path, 'utf8');
        if (typeof text !== 'string') {
          throw fail('env file cannot be read');
        }
        return text;
      } catch (error) {
        if (isOwnError(error)) throw error;
        throw fail('env file cannot be read');
      }
    };
    const benchmarkResult = await runSixCaseBenchmarkFromArgvV2({
      argv: parsedArgv.forwarded,
      dataset,
      fetchImpl: inspected.fetchImpl,
      readEnvText,
    });
    const payload = {
      benchmarkResult,
      semanticReviewPacket: execute
        ? buildSixCaseSemanticReviewPacketV2({ dataset, benchmarkResult })
        : null,
    };
    const text = writeSafe(inspected.writeStdout, payload);
    if (parsedArgv.outputFile !== undefined) {
      await writeSafeOutputFile(inspected, parsedArgv.outputFile, text);
    }
    return payload;
  } catch (error) {
    const message = isOwnError(error)
      ? error.message
      : '[memory-v3:live-benchmark-six-run-v2] run failed';
    const safeError = isOwnError(error) ? error : fail('run failed');
    try {
      writeSafe(inspected.writeStderr, publicFailure(message));
    } catch {
      // stdio failure must not leak the original error.
    }
    throw safeError;
  }
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

function writeProcessStream(stream, chunk) {
  stream.write(String(chunk));
}

async function runDirect() {
  try {
    await main({
      argv: process.argv.slice(2),
      readFileImpl: readFile,
      fetchImpl: globalThis.fetch.bind(globalThis),
      writeStdout: (chunk) => writeProcessStream(process.stdout, chunk),
      writeStderr: (chunk) => writeProcessStream(process.stderr, chunk),
      writeFileImpl: writeFile,
      linkImpl: link,
      unlinkImpl: unlink,
      accessImpl: access,
    });
  } catch {
    process.exitCode = 1;
  }
}

if (isDirectInvocation()) {
  await runDirect();
}
