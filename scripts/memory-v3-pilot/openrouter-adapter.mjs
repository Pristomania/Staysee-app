/**
 * Memory V3 Task 3A — OpenRouter adapter boundary.
 * Injected transport only. No fetch, env, retry, fallback, or network default.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high']);
const ITEM_FIELDS = Object.freeze([
  'itemRef',
  'kind',
  'claim',
  'status',
  'sensitivity',
  'eventTimeStart',
  'eventTimeEnd',
  'alternative',
]);
const EVIDENCE_FIELDS = Object.freeze([
  'itemRef',
  'sourceMessageId',
  'episodeKey',
  'relation',
]);

const OWN_ERRORS = new WeakSet();

function fail(stage, message) {
  const error = new Error(`[memory-v3:openrouter-${stage}] ${message}`);
  error.name = 'MemoryV3OpenRouterError';
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
  const allowed = [...required, ...optional];
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
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail(stage, `${path} is missing a required field`);
    }
  }
  return copy;
}

function projectRecord(value, path, stage, spec) {
  const keys = inspectPlainObject(value, path, stage);
  const required = new Set(spec.required);
  const pick = new Set([...(spec.required || []), ...(spec.pick || [])]);
  const forbidden = new Set(spec.forbidden || []);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol') {
      throw fail(stage, `${path} has an invalid field`);
    }
    const desc = dataDescriptor(value, key, path, stage);
    if (forbidden.has(key)) {
      throw fail(stage, `${path} has an invalid field`);
    }
    if (!pick.has(key)) continue;
    if (desc.value === undefined && required.has(key)) {
      throw fail(stage, `${path} is missing a required field`);
    }
    copy[key] = desc.value;
  }
  for (const field of spec.required) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail(stage, `${path} is missing a required field`);
    }
  }
  return copy;
}

function inspectDenseArray(value, path, stage) {
  if (!Array.isArray(value)) {
    throw fail(stage, `${path} must be a dense array`);
  }
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw fail(stage, `${path} must be a dense array`);
  }
  const length = value.length;
  const allowed = new Set(['length']);
  for (let i = 0; i < length; i += 1) {
    allowed.add(String(i));
  }
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      throw fail(stage, `${path} has an unknown field`);
    }
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
      !Object.prototype.hasOwnProperty.call(desc, 'value')
    ) {
      throw fail(stage, `${path} has an invalid field`);
    }
    if (key !== 'length' && desc.enumerable !== true) {
      throw fail(stage, `${path} has an invalid field`);
    }
  }
  const entries = [];
  for (let i = 0; i < length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(value, i);
    if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
      throw fail(stage, `${path} must be a dense array`);
    }
    entries.push(desc.value);
  }
  return entries;
}

function nullableStringSchema() {
  return { type: ['string', 'null'] };
}

function objectSchema(required, properties) {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  };
}

const MEMORY_V3_OPENROUTER_JSON_SCHEMA = Object.freeze({
  name: 'memory_v3_extractor_response',
  strict: true,
  schema: objectSchema(['items', 'evidence'], {
    items: {
      type: 'array',
      items: objectSchema(ITEM_FIELDS, {
        itemRef: { type: 'string' },
        kind: { type: 'string' },
        claim: { type: 'string' },
        status: { type: 'string' },
        sensitivity: { type: 'string' },
        eventTimeStart: nullableStringSchema(),
        eventTimeEnd: nullableStringSchema(),
        alternative: nullableStringSchema(),
      }),
    },
    evidence: {
      type: 'array',
      items: objectSchema(EVIDENCE_FIELDS, {
        itemRef: { type: 'string' },
        sourceMessageId: { type: 'string' },
        episodeKey: { type: 'string' },
        relation: { type: 'string' },
      }),
    },
  }),
});

function isHttpsUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function readContent(raw) {
  const envelope = projectRecord(raw, 'transport response', 'response', {
    required: ['status', 'body'],
    forbidden: ['error'],
  });
  if (
    !Number.isInteger(envelope.status) ||
    envelope.status < 200 ||
    envelope.status > 299
  ) {
    throw fail('response', 'transport status is not 2xx');
  }
  const body = projectRecord(envelope.body, 'transport response.body', 'response', {
    required: ['choices'],
    forbidden: ['error'],
  });
  const choices = inspectDenseArray(body.choices, 'choices', 'response');
  if (choices.length !== 1) {
    throw fail('response', 'transport response must contain exactly one choice');
  }
  const choice = projectRecord(choices[0], 'choices[0]', 'response', {
    required: ['message', 'finish_reason'],
    forbidden: ['error'],
  });
  if (choice.finish_reason !== 'stop') {
    throw fail('response', 'finish_reason must be stop');
  }
  const message = projectRecord(choice.message, 'choices[0].message', 'response', {
    required: ['content'],
    pick: ['role'],
    forbidden: ['tool_calls', 'function_call', 'refusal', 'error'],
  });
  if (message.role !== undefined && message.role !== 'assistant') {
    throw fail('response', 'message role must be assistant');
  }
  if (!isNonEmptyString(message.content)) {
    throw fail('response', 'message content is missing');
  }
  return message.content;
}

export function createOpenRouterAdapter(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw fail('config', 'options must be a plain object');
  }
  const inspected = inspectRecordPartial(
    options,
    ['transport', 'apiKey', 'model', 'maxOutputTokens'],
    ['appTitle', 'appUrl', 'reasoningEffort'],
    'options',
    'config',
  );
  if (typeof inspected.transport !== 'function') {
    throw fail('config', 'transport must be a function');
  }
  if (!isNonEmptyString(inspected.apiKey)) {
    throw fail('config', 'apiKey is required');
  }
  if (!isNonEmptyString(inspected.model)) {
    throw fail('config', 'model is required');
  }
  if (
    !Number.isInteger(inspected.maxOutputTokens) ||
    inspected.maxOutputTokens <= 0
  ) {
    throw fail('config', 'maxOutputTokens must be a positive integer');
  }
  if (inspected.appUrl !== undefined && !isHttpsUrl(inspected.appUrl)) {
    throw fail('config', 'appUrl must be an https URL');
  }
  if (inspected.appTitle !== undefined && !isNonEmptyString(inspected.appTitle)) {
    throw fail('config', 'appTitle must be a non-empty string');
  }
  if (
    inspected.reasoningEffort !== undefined &&
    !REASONING_EFFORTS.has(inspected.reasoningEffort)
  ) {
    throw fail('config', 'reasoningEffort is invalid');
  }

  const transport = inspected.transport;
  const apiKey = inspected.apiKey;
  const model = inspected.model;
  const maxOutputTokens = inspected.maxOutputTokens;
  const appTitle = inspected.appTitle;
  const appUrl = inspected.appUrl;
  const reasoningEffort = inspected.reasoningEffort;

  return async function openRouterModelAdapter(request) {
    const safeRequest = inspectRecord(request, ['system', 'input'], 'request', 'config');
    if (!isNonEmptyString(safeRequest.system)) {
      throw fail('config', 'request.system is required');
    }
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    if (appUrl !== undefined) headers['HTTP-Referer'] = appUrl;
    if (appTitle !== undefined) headers['X-Title'] = appTitle;

    const transportRequest = {
      url: OPENROUTER_URL,
      method: 'POST',
      headers,
      body: {
        model,
        messages: [
          { role: 'system', content: safeRequest.system },
          { role: 'user', content: JSON.stringify(safeRequest.input) },
        ],
        stream: false,
        max_tokens: maxOutputTokens,
        response_format: {
          type: 'json_schema',
          json_schema: structuredClone(MEMORY_V3_OPENROUTER_JSON_SCHEMA),
        },
        provider: {
          allow_fallbacks: false,
          require_parameters: true,
          data_collection: 'deny',
          zdr: true,
        },
      },
    };
    if (reasoningEffort !== undefined) {
      transportRequest.body.reasoning_effort = reasoningEffort;
    }

    let raw;
    try {
      raw = await transport(transportRequest);
    } catch (error) {
      if (isOwnError(error)) throw error;
      throw fail('transport', 'transport failed');
    }

    try {
      return readContent(raw);
    } catch (error) {
      if (isOwnError(error)) throw error;
      throw fail('response', 'transport response is invalid');
    }
  };
}
