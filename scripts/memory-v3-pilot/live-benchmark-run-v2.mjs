/**
 * Shared Memory V3 V2 profile-driven composition root.
 * Tests inject all IO. Direct execution supplies explicit platform defaults.
 */

import { access, link, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProfileBenchmarkFromArgvV2 } from './live-benchmark-cli-v2.mjs';
import { buildProfileSemanticReviewPacketV2 } from './live-benchmark-engine-v2.mjs';
import { getLiveBenchmarkProfileV2 } from './live-benchmark-profiles-v2.mjs';

export { runProfileBenchmarkFromArgvV2 } from './live-benchmark-cli-v2.mjs';
export { buildProfileSemanticReviewPacketV2 } from './live-benchmark-engine-v2.mjs';

const GOLDEN_DATASET_URL = new URL('./memory-v3-ru-golden.v2.json', import.meta.url);
const OWN_ERRORS = new WeakSet();
const GENERIC_PREFIX = '[memory-v3:live-benchmark-run-v2]';
const GENERIC_NAME = 'MemoryV3ProfileLiveBenchmarkRunV2Error';
const OPTION_REQUIRED = Object.freeze([
  'argv',
  'readFileImpl',
  'fetchImpl',
  'writeStdout',
  'writeStderr',
  'profileId',
]);
const OPTION_OPTIONAL = Object.freeze([
  'writeFileImpl',
  'linkImpl',
  'unlinkImpl',
  'accessImpl',
]);

function fail(message, canonical) {
  const error = new Error(`${canonical?.runErrorPrefix ?? GENERIC_PREFIX} ${message}`);
  error.name = canonical?.runErrorName ?? GENERIC_NAME;
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

function guardedIsArray(value, canonical, message) {
  try {
    return Array.isArray(value);
  } catch {
    throw fail(message, canonical);
  }
}

function inspectPlainObject(value, path, canonical) {
  if (value === null || typeof value !== 'object') {
    throw fail(`${path} must be a plain object`, canonical);
  }
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    throw fail(`${path} must be a plain object`, canonical);
  }
  if (guardedIsArray(value, canonical, `${path} must be a plain object`)) {
    throw fail(`${path} must be a plain object`, canonical);
  }
  if (proto !== Object.prototype && proto !== null) {
    throw fail(`${path} must be a plain object`, canonical);
  }
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw fail(`${path} has an invalid shape`, canonical);
  }
}

function dataDescriptor(value, key, path, canonical) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw fail(`${path} has an invalid shape`, canonical);
  }
  if (
    !desc ||
    typeof desc.get === 'function' ||
    typeof desc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(desc, 'value') ||
    desc.enumerable !== true
  ) {
    throw fail(`${path} has an invalid field`, canonical);
  }
  return desc;
}

function inspectRecordPartial(value, required, optional, path, canonical) {
  const keys = inspectPlainObject(value, path, canonical);
  const allowed = new Set([...required, ...optional]);
  const copy = Object.create(null);
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      throw fail(`${path} has an unknown field`, canonical);
    }
    const desc = dataDescriptor(value, key, path, canonical);
    if (desc.value === undefined) {
      throw fail(`${path} is missing a required field`, canonical);
    }
    Object.defineProperty(copy, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: desc.value,
    });
  }
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail(`${path} is missing a required field`, canonical);
    }
  }
  return copy;
}

function inspectDenseArray(value, path, canonical) {
  if (!guardedIsArray(value, canonical, `${path} must be a dense array`)) {
    throw fail(`${path} must be a dense array`, canonical);
  }
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw fail(`${path} must be a dense array`, canonical);
  }
  const descriptors = new Map();
  for (const key of keys) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw fail(`${path} has an invalid field`, canonical);
    }
    descriptors.set(key, desc);
  }
  const lengthDesc = descriptors.get('length');
  if (
    !lengthDesc ||
    typeof lengthDesc.get === 'function' ||
    typeof lengthDesc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(lengthDesc, 'value') ||
    !Number.isSafeInteger(lengthDesc.value) ||
    lengthDesc.value < 0
  ) {
    throw fail(`${path} must be a dense array`, canonical);
  }
  const allowed = new Set(['length']);
  for (let index = 0; index < lengthDesc.value; index += 1) allowed.add(String(index));
  for (const key of keys) {
    const desc = descriptors.get(key);
    if (
      typeof key === 'symbol' ||
      !allowed.has(key) ||
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value') ||
      (key !== 'length' && desc.enumerable !== true)
    ) {
      throw fail(`${path} has an invalid field`, canonical);
    }
  }
  const entries = [];
  for (let index = 0; index < lengthDesc.value; index += 1) {
    const desc = descriptors.get(String(index));
    if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
      throw fail(`${path} must be a dense array`, canonical);
    }
    entries.push(desc.value);
  }
  return entries;
}

function resolveCanonicalProfile(profileId) {
  try {
    return getLiveBenchmarkProfileV2(profileId);
  } catch {
    throw fail('profileId is not allowed');
  }
}

function isAbsoluteJsonPath(value) {
  return typeof value === 'string' && isAbsolute(value) && extname(value) === '.json';
}

function parseRunArgv(argv, canonical) {
  const entries = inspectDenseArray(argv, 'argv', canonical);
  const forwarded = [];
  let outputFile;
  for (let index = 0; index < entries.length; index += 1) {
    const arg = entries[index];
    if (arg === '--safe-output-file') {
      if (outputFile !== undefined) throw fail('argument is duplicated', canonical);
      const value = entries[index + 1];
      if (!isAbsoluteJsonPath(value)) throw fail('safe-output-file is invalid', canonical);
      outputFile = value;
      index += 1;
      continue;
    }
    forwarded.push(arg);
  }
  return {
    forwarded,
    outputFile,
    execute: forwarded.some((entry) => entry === canonical.executeFlag),
  };
}

function ownEnumerableDataValue(value, key) {
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

function isEnoent(error) {
  const code = ownEnumerableDataValue(error, 'code');
  return code.ok && code.value === 'ENOENT';
}

async function assertAbsent(accessImpl, path, canonical) {
  try {
    await accessImpl(path);
  } catch (error) {
    if (isEnoent(error)) return;
    throw fail('output file cannot be used', canonical);
  }
  throw fail('output file already exists', canonical);
}

async function publishSafeOutput(inspected, outputFile, text, canonical) {
  const temporaryPath = `${outputFile}.tmp`;
  let tempCreated = false;
  try {
    await inspected.writeFileImpl(temporaryPath, text, { encoding: 'utf8', flag: 'wx' });
    tempCreated = true;
  } catch {
    throw fail('output file cannot be written', canonical);
  }
  try {
    await inspected.linkImpl(temporaryPath, outputFile);
  } catch {
    if (tempCreated) {
      try {
        await inspected.unlinkImpl(temporaryPath);
      } catch {
        // Cleanup failures are deliberately hidden.
      }
    }
    throw fail('output file cannot be written', canonical);
  }
  try {
    await inspected.unlinkImpl(temporaryPath);
    tempCreated = false;
  } catch {
    // The unlink may already have removed the owned temp. Never retry when ownership is uncertain.
    throw fail('output file cannot be written', canonical);
  }
}

async function loadGoldenDataset(readFileImpl, canonical) {
  let text;
  try {
    text = await readFileImpl(GOLDEN_DATASET_URL, 'utf8');
  } catch {
    throw fail('dataset cannot be read', canonical);
  }
  if (typeof text !== 'string') throw fail('dataset is invalid', canonical);
  try {
    return JSON.parse(text);
  } catch {
    throw fail('dataset is invalid', canonical);
  }
}

function serialize(payload, canonical) {
  try {
    return `${JSON.stringify(payload)}\n`;
  } catch {
    throw fail('result cannot be serialized', canonical);
  }
}

async function writeOutput(writer, text, canonical) {
  if (typeof writer !== 'function') throw fail('writer must be a function', canonical);
  try {
    await writer(text);
  } catch {
    throw fail('writer failed', canonical);
  }
}

function publicFailure(message) {
  return { ok: false, stage: 'config', error: message };
}

export async function main(options) {
  const initial = inspectRecordPartial(
    options,
    OPTION_REQUIRED,
    OPTION_OPTIONAL,
    'options',
  );
  if (typeof initial.profileId !== 'string' || initial.profileId.length === 0) {
    throw fail('profileId is not allowed');
  }
  const canonical = resolveCanonicalProfile(initial.profileId);
  const inspected = inspectRecordPartial(
    options,
    OPTION_REQUIRED,
    OPTION_OPTIONAL,
    'options',
    canonical,
  );
  for (const key of ['readFileImpl', 'fetchImpl', 'writeStdout', 'writeStderr']) {
    if (typeof inspected[key] !== 'function') throw fail(`${key} must be a function`, canonical);
  }
  for (const key of OPTION_OPTIONAL) {
    if (
      Object.prototype.hasOwnProperty.call(inspected, key) &&
      typeof inspected[key] !== 'function'
    ) {
      throw fail(`${key} must be a function`, canonical);
    }
  }

  try {
    const parsed = parseRunArgv(inspected.argv, canonical);
    if (parsed.outputFile !== undefined && !parsed.execute) {
      throw fail('safe-output-file requires execute', canonical);
    }
    if (parsed.outputFile !== undefined) {
      for (const key of ['writeFileImpl', 'linkImpl', 'unlinkImpl', 'accessImpl']) {
        if (typeof inspected[key] !== 'function') throw fail(`${key} must be a function`, canonical);
      }
      await assertAbsent(inspected.accessImpl, parsed.outputFile, canonical);
      await assertAbsent(inspected.accessImpl, `${parsed.outputFile}.tmp`, canonical);
    }

    const dataset = await loadGoldenDataset(inspected.readFileImpl, canonical);
    const readEnvText = async (path) => {
      let text;
      try {
        text = await inspected.readFileImpl(path, 'utf8');
      } catch {
        throw fail('env file cannot be read', canonical);
      }
      if (typeof text !== 'string') throw fail('env file cannot be read', canonical);
      return text;
    };
    const benchmarkResult = await runProfileBenchmarkFromArgvV2({
      argv: parsed.forwarded,
      dataset,
      profileId: canonical.profileId,
      fetchImpl: inspected.fetchImpl,
      readEnvText,
    });
    const payload = {
      benchmarkResult,
      semanticReviewPacket: parsed.execute
        ? buildProfileSemanticReviewPacketV2({
            dataset,
            benchmarkResult,
            profileId: canonical.profileId,
          })
        : null,
    };
    const text = serialize(payload, canonical);
    await writeOutput(inspected.writeStdout, text, canonical);
    if (parsed.outputFile !== undefined) {
      await publishSafeOutput(inspected, parsed.outputFile, text, canonical);
    }
    return payload;
  } catch (error) {
    const safe = isOwnError(error) ? error : fail('run failed', canonical);
    try {
      await writeOutput(
        inspected.writeStderr,
        serialize(publicFailure(safe.message), canonical),
        canonical,
      );
    } catch {
      // Stderr failures cannot expose the original error.
    }
    throw safe;
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
      profileId: 'six-category-v2',
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

if (isDirectInvocation()) await runDirect();
