/**
 * Memory V3 offline extractor — strict single-call core.
 * Injected fake/provider adapter only. No network, filesystem, env, or retries.
 */

import { makeLocalItemKey, validateCase, validateExtraction } from './contracts.mjs';
import { buildExtractorRequest } from './extractor-prompt.mjs';

const TOP_LEVEL_FIELDS = Object.freeze(['items', 'evidence']);
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
  const error = new Error(`[memory-v3:${stage}] ${message}`);
  error.name = 'MemoryV3ExtractorError';
  OWN_ERRORS.add(error);
  return error;
}

function isMemoryV3Error(error) {
  return (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    OWN_ERRORS.has(error)
  );
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function inspectRecord(value, allowed, path) {
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    throw fail('shape', `${path} must be a plain object`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('shape', `${path} must be a plain object`);
  }
  if (proto !== Object.prototype && proto !== null) {
    throw fail('shape', `${path} must be a plain object`);
  }

  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw fail('shape', `${path} has an invalid shape`);
  }

  const allowedSet = new Set(allowed);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowedSet.has(key)) {
      throw fail('shape', `${path} has an unknown field`);
    }
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw fail('shape', `${path} has an invalid shape`);
    }
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value') ||
      desc.enumerable !== true
    ) {
      throw fail('shape', `${path} has an invalid field`);
    }
    if (desc.value === undefined) {
      throw fail('shape', `${path} is missing a required field`);
    }
    copy[key] = desc.value;
  }
  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail('shape', `${path} is missing a required field`);
    }
  }
  return copy;
}

function inspectDenseArray(value, path) {
  if (!Array.isArray(value)) {
    throw fail('shape', `${path} must be a dense array`);
  }

  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw fail('shape', `${path} must be a dense array`);
  }

  const length = value.length;
  const allowed = new Set(['length']);
  for (let i = 0; i < length; i += 1) {
    allowed.add(String(i));
  }

  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      throw fail('shape', `${path} has an unknown field`);
    }
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw fail('shape', `${path} has an invalid shape`);
    }
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value')
    ) {
      throw fail('shape', `${path} has an invalid field`);
    }
    if (key !== 'length' && desc.enumerable !== true) {
      throw fail('shape', `${path} has an invalid field`);
    }
  }

  const entries = [];
  for (let i = 0; i < length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(value, i);
    if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
      throw fail('shape', `${path} must be a dense array`);
    }
    entries.push(desc.value);
  }
  return entries;
}

function parseAdapterOutput(raw) {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      throw fail('parse', 'adapter returned malformed JSON');
    }
  }
  return raw;
}

function messageById(caseData) {
  const map = new Map();
  for (const message of caseData.messages) {
    map.set(message.id, message);
  }
  return map;
}

function assertNonEmptyString(value, path) {
  if (!isNonEmptyString(value)) {
    throw fail('shape', `${path} is invalid`);
  }
}

function assertStringOrNull(value, path) {
  if (value !== null && typeof value !== 'string') {
    throw fail('shape', `${path} is invalid`);
  }
}

function normalizeItems(items) {
  const list = inspectDenseArray(items, 'items');
  const refToKey = new Map();
  const normalized = list.map((rawItem, index) => {
    const path = `items[${index}]`;
    const item = inspectRecord(rawItem, ITEM_FIELDS, path);
    assertNonEmptyString(item.itemRef, `${path}.itemRef`);
    assertNonEmptyString(item.kind, `${path}.kind`);
    assertNonEmptyString(item.claim, `${path}.claim`);
    assertNonEmptyString(item.status, `${path}.status`);
    assertNonEmptyString(item.sensitivity, `${path}.sensitivity`);
    assertStringOrNull(item.eventTimeStart, `${path}.eventTimeStart`);
    assertStringOrNull(item.eventTimeEnd, `${path}.eventTimeEnd`);
    assertStringOrNull(item.alternative, `${path}.alternative`);
    if (refToKey.has(item.itemRef)) {
      throw fail('shape', `${path}.itemRef is duplicate`);
    }
    const normalizedItem = {
      kind: item.kind,
      claim: item.claim,
      status: item.status,
      sensitivity: item.sensitivity,
      eventTimeStart: item.eventTimeStart,
      eventTimeEnd: item.eventTimeEnd,
      alternative: item.alternative,
      scope: 'cross_conversation',
      conversationId: null,
    };
    const localItemKey = makeLocalItemKey(normalizedItem, index);
    refToKey.set(item.itemRef, localItemKey);
    return { ...normalizedItem, localItemKey };
  });
  return { items: normalized, refToKey };
}

function normalizeEvidence(evidence, refToKey, caseData) {
  const list = inspectDenseArray(evidence, 'evidence');
  const messages = messageById(caseData);
  return list.map((rawEntry, index) => {
    const path = `evidence[${index}]`;
    const entry = inspectRecord(rawEntry, EVIDENCE_FIELDS, path);
    assertNonEmptyString(entry.itemRef, `${path}.itemRef`);
    assertNonEmptyString(entry.sourceMessageId, `${path}.sourceMessageId`);
    assertNonEmptyString(entry.episodeKey, `${path}.episodeKey`);
    assertNonEmptyString(entry.relation, `${path}.relation`);
    if (!refToKey.has(entry.itemRef)) {
      throw fail('shape', `${path}.itemRef is unknown`);
    }
    if (!messages.has(entry.sourceMessageId)) {
      throw fail('shape', `${path}.sourceMessageId is unknown`);
    }
    const message = messages.get(entry.sourceMessageId);
    if (message.role !== 'user') {
      throw fail(
        'contract',
        'assistant and system messages cannot be cited as evidence',
      );
    }
    return {
      itemKey: refToKey.get(entry.itemRef),
      sourceMessageId: entry.sourceMessageId,
      episodeKey: entry.episodeKey,
      relation: entry.relation,
      provenanceRole: message.role,
      mentionTime: message.createdAt,
    };
  });
}

function finalizeExtraction(raw, validated, extractorVersion) {
  const parsed = parseAdapterOutput(raw);
  const response = inspectRecord(parsed, TOP_LEVEL_FIELDS, 'adapter response');
  const { items, refToKey } = normalizeItems(response.items);
  const evidence = normalizeEvidence(response.evidence, refToKey, validated);
  const extraction = {
    run: {
      caseId: validated.caseId,
      extractorVersion,
    },
    items,
    evidence,
  };
  try {
    return validateExtraction(extraction, validated);
  } catch {
    throw fail('contract', 'normalized extraction is contract-invalid');
  }
}

export async function extractCase(caseData, modelAdapter, options) {
  if (typeof modelAdapter !== 'function') {
    throw fail('shape', 'modelAdapter must be a function');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw fail('shape', 'options must be a plain object');
  }
  const inspectedOptions = inspectRecord(options, ['extractorVersion'], 'options');
  if (!isNonEmptyString(inspectedOptions.extractorVersion)) {
    throw fail('shape', 'options.extractorVersion is required');
  }

  let validated;
  try {
    validated = validateCase(caseData);
  } catch {
    throw fail('shape', 'case is invalid');
  }

  const request = buildExtractorRequest(validated);

  let raw;
  try {
    raw = await modelAdapter(request);
  } catch {
    throw fail('adapter', 'adapter failed');
  }

  try {
    return finalizeExtraction(raw, validated, inspectedOptions.extractorVersion);
  } catch (error) {
    if (isMemoryV3Error(error)) throw error;
    throw fail('shape', 'adapter response is invalid');
  }
}
