/** Memory V3 V2 hypothesis-four composition-root wrapper. */

import { access, link, readFile, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getLiveBenchmarkProfileV2 } from './live-benchmark-profiles-v2.mjs';
import { main as runProfileMain } from './live-benchmark-run-v2.mjs';

const CANONICAL = getLiveBenchmarkProfileV2('hypothesis-four-v2');
const REQUIRED = Object.freeze([
  'argv',
  'readFileImpl',
  'fetchImpl',
  'writeStdout',
  'writeStderr',
]);
const OPTIONAL = Object.freeze(['writeFileImpl', 'linkImpl', 'unlinkImpl', 'accessImpl']);

function fail(message) {
  const error = new Error(`${CANONICAL.runErrorPrefix} ${message}`);
  error.name = CANONICAL.runErrorName;
  return error;
}

function inspectOptions(options) {
  if (options === null || typeof options !== 'object') throw fail('options must be a plain object');
  let proto;
  let keys;
  let isArray;
  try {
    isArray = Array.isArray(options);
    proto = Object.getPrototypeOf(options);
    keys = Reflect.ownKeys(options);
  } catch {
    throw fail('options must be a plain object');
  }
  if (isArray) throw fail('options must be a plain object');
  if (proto !== Object.prototype && proto !== null) throw fail('options must be a plain object');
  const allowed = new Set([...REQUIRED, ...OPTIONAL]);
  const copy = Object.create(null);
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) throw fail('options has an unknown field');
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(options, key);
    } catch {
      throw fail('options has an invalid shape');
    }
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value') ||
      desc.enumerable !== true ||
      desc.value === undefined
    ) {
      throw fail('options has an invalid field');
    }
    copy[key] = desc.value;
  }
  for (const key of REQUIRED) {
    if (!Object.prototype.hasOwnProperty.call(copy, key)) throw fail('options is missing a field');
  }
  return copy;
}

export async function main(options) {
  const inspected = inspectOptions(options);
  return runProfileMain({ ...inspected, profileId: CANONICAL.profileId });
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

async function runDirect() {
  try {
    await main({
      argv: process.argv.slice(2),
      readFileImpl: readFile,
      fetchImpl: globalThis.fetch.bind(globalThis),
      writeStdout: (chunk) => process.stdout.write(String(chunk)),
      writeStderr: (chunk) => process.stderr.write(String(chunk)),
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
