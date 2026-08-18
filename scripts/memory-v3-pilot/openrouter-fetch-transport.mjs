/**
 * Memory V3 Task 3B — injected OpenRouter HTTP fetch transport.
 * fetchImpl is required. No globalThis.fetch fallback, retry, env, or network default.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const HEADER_REQUIRED = Object.freeze(['Authorization', 'Content-Type']);
const HEADER_OPTIONAL = Object.freeze(['HTTP-Referer', 'X-Title']);
const REQUEST_FIELDS = Object.freeze(['url', 'method', 'headers', 'body']);

const OWN_ERRORS = new WeakSet();

function fail(stage, message) {
  const error = new Error(`[memory-v3:fetch-${stage}] ${message}`);
  error.name = 'MemoryV3FetchError';
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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function inspectPlainObject(value, path, stage) {
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    throw fail(stage, `${path} must be a plain object`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(stage, `${path} must be a plain object`);
  }
  if (proto !== Object.prototype && proto !== null) {
    throw fail(stage, `${path} must be a plain object`);
  }
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw fail(stage, `${path} has an invalid shape`);
  }
}

function dataDescriptor(value, key, path, stage) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw fail(stage, `${path} has an invalid shape`);
  }
  if (
    !desc ||
    typeof desc.get === 'function' ||
    typeof desc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(desc, 'value') ||
    desc.enumerable !== true
  ) {
    throw fail(stage, `${path} has an invalid field`);
  }
  return desc;
}

function inspectRecord(value, allowed, path, stage) {
  const keys = inspectPlainObject(value, path, stage);
  const allowedSet = new Set(allowed);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowedSet.has(key)) {
      throw fail(stage, `${path} has an unknown field`);
    }
    const desc = dataDescriptor(value, key, path, stage);
    if (desc.value === undefined) {
      throw fail(stage, `${path} is missing a required field`);
    }
    copy[key] = desc.value;
  }
  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail(stage, `${path} is missing a required field`);
    }
  }
  return copy;
}

function inspectRecordPartial(value, required, optional, path, stage) {
  const keys = inspectPlainObject(value, path, stage);
  const allowedSet = new Set([...required, ...optional]);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowedSet.has(key)) {
      throw fail(stage, `${path} has an unknown field`);
    }
    const desc = dataDescriptor(value, key, path, stage);
    if (desc.value === undefined) {
      throw fail(stage, `${path} is missing a required field`);
    }
    copy[key] = desc.value;
  }
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail(stage, `${path} is missing a required field`);
    }
  }
  return copy;
}

function cloneJsonData(value, path, stage) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail(stage, `${path} is invalid`);
    return value;
  }
  if (Array.isArray(value)) {
    let keys;
    try {
      keys = Reflect.ownKeys(value);
    } catch {
      throw fail(stage, `${path} must be a dense array`);
    }
    const length = value.length;
    const allowed = new Set(['length']);
    for (let i = 0; i < length; i += 1) allowed.add(String(i));
    for (const key of keys) {
      if (typeof key === 'symbol' || !allowed.has(key)) {
        throw fail(stage, `${path} has an invalid field`);
      }
      let desc;
      try {
        desc = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        throw fail(stage, `${path} has an invalid field`);
      }
      if (
        !desc ||
        typeof desc.get === 'function' ||
        typeof desc.set === 'function' ||
        !Object.prototype.hasOwnProperty.call(desc, 'value')
      ) {
        throw fail(stage, `${path} has an invalid field`);
      }
      if (key !== 'length' && desc.enumerable !== true) {
        throw fail(stage, `${path} has an invalid field`);
      }
    }
    const items = [];
    for (let i = 0; i < length; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(value, i);
      if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
        throw fail(stage, `${path} must be a dense array`);
      }
      items.push(cloneJsonData(desc.value, `${path}[${i}]`, stage));
    }
    return items;
  }
  const keys = inspectPlainObject(value, path, stage);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol') throw fail(stage, `${path} has an invalid field`);
    const desc = dataDescriptor(value, key, path, stage);
    copy[key] = cloneJsonData(desc.value, `${path}.${key}`, stage);
  }
  return copy;
}

function byteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

function inspectOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw fail('config', 'options must be a plain object');
  }
  const inspected = inspectRecordPartial(
    options,
    ['fetchImpl', 'timeoutMs', 'maxResponseBytes'],
    ['setTimeoutImpl', 'clearTimeoutImpl'],
    'options',
    'config',
  );
  if (typeof inspected.fetchImpl !== 'function') {
    throw fail('config', 'fetchImpl must be a function');
  }
  if (!Number.isInteger(inspected.timeoutMs) || inspected.timeoutMs <= 0) {
    throw fail('config', 'timeoutMs must be a positive integer');
  }
  if (
    !Number.isInteger(inspected.maxResponseBytes) ||
    inspected.maxResponseBytes <= 0 ||
    inspected.maxResponseBytes > Number.MAX_SAFE_INTEGER
  ) {
    throw fail('config', 'maxResponseBytes must be a positive safe integer');
  }
  const hasSet = inspected.setTimeoutImpl !== undefined;
  const hasClear = inspected.clearTimeoutImpl !== undefined;
  if (hasSet !== hasClear) {
    throw fail('config', 'setTimeoutImpl and clearTimeoutImpl must be provided together');
  }
  if (hasSet && typeof inspected.setTimeoutImpl !== 'function') {
    throw fail('config', 'setTimeoutImpl must be a function');
  }
  if (hasClear && typeof inspected.clearTimeoutImpl !== 'function') {
    throw fail('config', 'clearTimeoutImpl must be a function');
  }
  return inspected;
}

function inspectTransportRequest(request) {
  const inspected = inspectRecord(request, REQUEST_FIELDS, 'transport request', 'request');
  if (inspected.url !== OPENROUTER_URL) {
    throw fail('request', 'url is not the OpenRouter chat completions endpoint');
  }
  if (inspected.method !== 'POST') {
    throw fail('request', 'method must be POST');
  }
  const headers = inspectRecordPartial(
    inspected.headers,
    HEADER_REQUIRED,
    HEADER_OPTIONAL,
    'headers',
    'request',
  );
  if (
    !isNonEmptyString(headers.Authorization) ||
    !headers.Authorization.startsWith('Bearer ') ||
    headers.Authorization.slice(7).trim().length === 0
  ) {
    throw fail('request', 'Authorization header is invalid');
  }
  if (headers['Content-Type'] !== 'application/json') {
    throw fail('request', 'Content-Type must be application/json');
  }
  if (headers['HTTP-Referer'] !== undefined && !isNonEmptyString(headers['HTTP-Referer'])) {
    throw fail('request', 'HTTP-Referer is invalid');
  }
  if (headers['X-Title'] !== undefined && !isNonEmptyString(headers['X-Title'])) {
    throw fail('request', 'X-Title is invalid');
  }
  if (
    inspected.body === null ||
    typeof inspected.body !== 'object' ||
    Array.isArray(inspected.body)
  ) {
    throw fail('request', 'body must be a plain object');
  }
  return {
    url: inspected.url,
    method: inspected.method,
    headers,
    body: cloneJsonData(inspected.body, 'body', 'request'),
  };
}

async function readFetchResponse(raw, maxResponseBytes, controller) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('response', 'fetch response is invalid');
  }
  let status;
  let textFn;
  try {
    status = raw.status;
    textFn = raw.text;
  } catch {
    throw fail('response', 'fetch response is invalid');
  }
  if (!Number.isInteger(status)) {
    throw fail('response', 'fetch status is invalid');
  }
  if (typeof textFn !== 'function') {
    throw fail('response', 'fetch response text is missing');
  }
  let text;
  try {
    text = await textFn.call(raw);
  } catch (error) {
    if (isOwnError(error)) throw error;
    if (controller.signal.aborted) {
      throw fail('timeout', 'fetch timed out');
    }
    throw fail('response', 'fetch response text failed');
  }
  if (typeof text !== 'string') {
    throw fail('response', 'fetch response text is invalid');
  }
  if (byteLength(text) > maxResponseBytes) {
    throw fail('response', 'fetch response exceeds maxResponseBytes');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail('response', 'fetch response is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('response', 'fetch response JSON must be an object');
  }
  return { status, body: parsed };
}

export function createOpenRouterFetchTransport(options) {
  const inspected = inspectOptions(options);
  const fetchImpl = inspected.fetchImpl;
  const timeoutMs = inspected.timeoutMs;
  const maxResponseBytes = inspected.maxResponseBytes;
  const setTimeoutImpl = inspected.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = inspected.clearTimeoutImpl ?? clearTimeout;

  return async function openRouterFetchTransport(request) {
    const safeRequest = inspectTransportRequest(request);
    const initHeaders = {
      Authorization: safeRequest.headers.Authorization,
      'Content-Type': safeRequest.headers['Content-Type'],
    };
    if (safeRequest.headers['HTTP-Referer'] !== undefined) {
      initHeaders['HTTP-Referer'] = safeRequest.headers['HTTP-Referer'];
    }
    if (safeRequest.headers['X-Title'] !== undefined) {
      initHeaders['X-Title'] = safeRequest.headers['X-Title'];
    }

    const controller = new AbortController();
    const timer = setTimeoutImpl(() => controller.abort(), timeoutMs);
    try {
      let raw;
      try {
        raw = await fetchImpl(safeRequest.url, {
          method: safeRequest.method,
          headers: initHeaders,
          body: JSON.stringify(safeRequest.body),
          signal: controller.signal,
        });
      } catch (error) {
        if (isOwnError(error)) throw error;
        if (controller.signal.aborted) {
          throw fail('timeout', 'fetch timed out');
        }
        throw fail('transport', 'fetch failed');
      }

      try {
        return await readFetchResponse(raw, maxResponseBytes, controller);
      } catch (error) {
        if (isOwnError(error)) throw error;
        if (controller.signal.aborted) {
          throw fail('timeout', 'fetch timed out');
        }
        throw fail('response', 'fetch response is invalid');
      }
    } finally {
      clearTimeoutImpl(timer);
    }
  };
}
