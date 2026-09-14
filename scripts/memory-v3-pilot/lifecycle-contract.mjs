/**
 * Memory V3 synthetic lifecycle runtime contract.
 * Pure JSON-data-only validation. No filesystem, env, provider, or network access.
 */

import { EVIDENCE_RELATIONS, ITEM_KINDS } from './contracts.mjs';
import { V2_SUPPORT_TYPES } from './contracts-v2.mjs';

export const LIFECYCLE_OPERATION_TYPES = Object.freeze([
  'create',
  'confirm',
  'revise',
  'mark_stale',
  'reject',
  'ignore',
]);

export const LIFECYCLE_CURRENT_STATUS_BY_KIND = Object.freeze({
  event: Object.freeze(['active']),
  recurrence: Object.freeze(['candidate', 'active']),
  hypothesis: Object.freeze(['candidate', 'supported']),
});

export const LIFECYCLE_CLOSED_STATUS_BY_KIND = Object.freeze({
  event: Object.freeze(['corrected', 'rejected']),
  recurrence: Object.freeze(['stale', 'rejected']),
  hypothesis: Object.freeze(['stale', 'rejected']),
});

const OWN_ERRORS = new WeakSet();
const ERROR_TOKENS = new WeakMap();
const DIAGNOSTICS = new Set([
  'lifecycle_contract_invalid_shape',
  'lifecycle_contract_invalid_state',
  'lifecycle_contract_invalid_proposal',
  'lifecycle_contract_invalid_forget',
]);
const STATUS_RELATION = Object.freeze({
  active: 'supports',
  candidate: 'supports',
  supported: 'supports',
  corrected: 'corrects',
  stale: 'contradicts',
  rejected: 'rejects',
});
const SESSION_FIELDS = Object.freeze(['scenarioId', 'stepId', 'at', 'conversationId']);
const STATE_FIELDS = Object.freeze(['scenarioId', 'nextMemoryOrdinal', 'items']);
const ITEM_FIELDS = Object.freeze([
  'memoryKey',
  'kind',
  'claim',
  'status',
  'sensitivity',
  'eventTimeStart',
  'eventTimeEnd',
  'alternative',
  'firstSeenAt',
  'updatedAt',
  'revision',
  'evidence',
]);
const EVIDENCE_FIELDS = Object.freeze([
  'conversationId',
  'sourceMessageId',
  'relation',
  'supportType',
  'episodeKey',
  'provenanceRole',
  'mentionTime',
]);
const PROPOSAL_FIELDS = Object.freeze([
  'type',
  'candidateLocalItemKey',
  'targetMemoryKey',
]);
const EXTRACTION_FIELDS = Object.freeze(['run', 'items', 'evidence']);
const RUN_FIELDS = Object.freeze(['caseId', 'extractorVersion']);
const EXTRACTION_ITEM_FIELDS = Object.freeze([
  'localItemKey',
  'kind',
  'claim',
  'scope',
  'conversationId',
  'eventTimeStart',
  'eventTimeEnd',
  'status',
  'sensitivity',
  'alternative',
]);
const EXTRACTION_EVIDENCE_FIELDS = Object.freeze([
  'itemKey',
  'sourceMessageId',
  'episodeKey',
  'relation',
  'supportType',
  'provenanceRole',
  'mentionTime',
]);
const CONTEXT_FIELDS = Object.freeze(['state', 'extraction']);

function makeError(token, message, diagnosticCode) {
  const error = new Error(`[memory-v3:lifecycle-contract] ${message}`);
  error.name = 'MemoryV3LifecycleContractError';
  Object.defineProperty(error, 'diagnosticCode', {
    value: diagnosticCode,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  OWN_ERRORS.add(error);
  ERROR_TOKENS.set(error, token);
  return error;
}

function fail(token, message, diagnosticCode) {
  throw makeError(token, message, diagnosticCode);
}

function boundary(defaultDiagnostic, fn) {
  const token = Object.freeze({});
  try {
    return fn(token);
  } catch (error) {
    if (OWN_ERRORS.has(error) && ERROR_TOKENS.get(error) === token) throw error;
    throw makeError(token, 'value has an invalid shape', defaultDiagnostic);
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMemoryKey(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isValidIsoDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59
  ) return false;
  if (match[8] !== 'Z') {
    const offset = /^([+-])(\d{2}):(\d{2})$/.exec(match[8]);
    if (!offset) return false;
    const offsetHour = Number(offset[2]);
    const offsetMinute = Number(offset[3]);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isValidIsoDateOrDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return isValidIsoDateTime(value);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function sortableInstant(value) {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
}

function ownKeys(token, value, diagnosticCode) {
  if (value === null || typeof value !== 'object') {
    fail(token, 'value must be a plain object', diagnosticCode);
  }
  let array;
  let prototype;
  let keys;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(token, 'value has an invalid shape', diagnosticCode);
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) {
    fail(token, 'value must be a plain object', diagnosticCode);
  }
  return keys;
}

function descriptor(token, value, key, diagnosticCode) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail(token, 'value has an invalid shape', diagnosticCode);
  }
  if (
    !desc ||
    typeof desc.get === 'function' ||
    typeof desc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(desc, 'value') ||
    desc.enumerable !== true ||
    desc.value === undefined
  ) {
    fail(token, 'value has an invalid field', diagnosticCode);
  }
  return desc.value;
}

function record(token, value, fields, diagnosticCode) {
  const keys = ownKeys(token, value, diagnosticCode);
  const allowed = new Set(fields);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      fail(token, 'value has an unknown field', diagnosticCode);
    }
    copy[key] = descriptor(token, value, key, diagnosticCode);
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      fail(token, 'value is missing a required field', diagnosticCode);
    }
  }
  return copy;
}

function denseArray(token, value, diagnosticCode) {
  let isArray;
  let keys;
  try {
    isArray = Array.isArray(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(token, 'value must be a dense array', diagnosticCode);
  }
  if (!isArray) fail(token, 'value must be a dense array', diagnosticCode);
  let lengthDesc;
  try {
    lengthDesc = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail(token, 'value must be a dense array', diagnosticCode);
  }
  if (
    !lengthDesc ||
    !Object.prototype.hasOwnProperty.call(lengthDesc, 'value') ||
    !Number.isSafeInteger(lengthDesc.value) ||
    lengthDesc.value < 0
  ) fail(token, 'value must be a dense array', diagnosticCode);
  const length = lengthDesc.value;
  const allowed = new Set(['length']);
  for (let index = 0; index < length; index += 1) allowed.add(String(index));
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      fail(token, 'array has an invalid field', diagnosticCode);
    }
  }
  const entries = [];
  for (let index = 0; index < length; index += 1) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail(token, 'value must be a dense array', diagnosticCode);
    }
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value') ||
      desc.enumerable !== true ||
      desc.value === undefined
    ) fail(token, 'value must be a dense array', diagnosticCode);
    entries.push(desc.value);
  }
  return entries;
}

function requireString(token, value, diagnosticCode) {
  if (!isNonEmptyString(value)) fail(token, 'value must be a non-empty string', diagnosticCode);
  return value;
}

function validateSessionInternal(token, value) {
  const code = 'lifecycle_contract_invalid_shape';
  const entry = record(token, value, SESSION_FIELDS, code);
  requireString(token, entry.scenarioId, code);
  requireString(token, entry.stepId, code);
  requireString(token, entry.conversationId, code);
  if (!isValidIsoDateTime(entry.at)) fail(token, 'session timestamp is invalid', code);
  return { ...entry };
}

function validateEvidenceInternal(token, value, kind, status) {
  const shapeCode = 'lifecycle_contract_invalid_shape';
  const stateCode = 'lifecycle_contract_invalid_state';
  const entry = record(token, value, EVIDENCE_FIELDS, shapeCode);
  requireString(token, entry.conversationId, stateCode);
  requireString(token, entry.sourceMessageId, stateCode);
  if (!EVIDENCE_RELATIONS.includes(entry.relation)) {
    fail(token, 'evidence relation is invalid', stateCode);
  }
  if (entry.provenanceRole !== 'user') {
    fail(token, 'evidence must cite a user message', stateCode);
  }
  if (!isValidIsoDateTime(entry.mentionTime)) {
    fail(token, 'evidence timestamp is invalid', stateCode);
  }
  const typedSupports = kind === 'recurrence' && entry.relation === 'supports';
  if (typedSupports) {
    if (!V2_SUPPORT_TYPES.includes(entry.supportType)) {
      fail(token, 'recurrence support type is invalid', stateCode);
    }
    if (entry.supportType === 'episode_observation') {
      requireString(token, entry.episodeKey, stateCode);
    } else if (entry.episodeKey !== null) {
      fail(token, 'non-observation recurrence support must use null episode key', stateCode);
    }
  } else {
    if (entry.supportType !== null) {
      fail(token, 'non-recurrence support type must be null', stateCode);
    }
    requireString(token, entry.episodeKey, stateCode);
  }
  if (entry.relation === STATUS_RELATION[status]) return { ...entry };
  return { ...entry };
}

function validateItemInternal(token, value) {
  const shapeCode = 'lifecycle_contract_invalid_shape';
  const stateCode = 'lifecycle_contract_invalid_state';
  const entry = record(token, value, ITEM_FIELDS, shapeCode);
  if (!isMemoryKey(entry.memoryKey)) fail(token, 'memory key is invalid', stateCode);
  if (!ITEM_KINDS.includes(entry.kind)) fail(token, 'memory kind is invalid', stateCode);
  requireString(token, entry.claim, stateCode);
  const statuses = [
    ...LIFECYCLE_CURRENT_STATUS_BY_KIND[entry.kind],
    ...LIFECYCLE_CLOSED_STATUS_BY_KIND[entry.kind],
  ];
  if (!statuses.includes(entry.status)) fail(token, 'memory status is invalid', stateCode);
  if (entry.sensitivity !== 'normal' && entry.sensitivity !== 'sensitive') {
    fail(token, 'memory sensitivity is invalid', stateCode);
  }
  for (const field of ['eventTimeStart', 'eventTimeEnd']) {
    if (entry[field] !== null && !isValidIsoDateOrDateTime(entry[field])) {
      fail(token, 'memory event time is invalid', stateCode);
    }
  }
  if (
    entry.eventTimeStart !== null &&
    entry.eventTimeEnd !== null &&
    sortableInstant(entry.eventTimeStart) > sortableInstant(entry.eventTimeEnd)
  ) fail(token, 'memory event time range is invalid', stateCode);
  if (entry.kind === 'hypothesis') {
    requireString(token, entry.alternative, stateCode);
  } else if (entry.alternative !== null) {
    fail(token, 'alternative must be null outside hypotheses', stateCode);
  }
  if (!isValidIsoDateTime(entry.firstSeenAt) || !isValidIsoDateTime(entry.updatedAt)) {
    fail(token, 'memory lifecycle timestamp is invalid', stateCode);
  }
  if (Date.parse(entry.updatedAt) < Date.parse(entry.firstSeenAt)) {
    fail(token, 'memory lifecycle timestamp order is invalid', stateCode);
  }
  if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) {
    fail(token, 'memory revision is invalid', stateCode);
  }
  const evidence = denseArray(token, entry.evidence, shapeCode).map((row) =>
    validateEvidenceInternal(token, row, entry.kind, entry.status));
  if (evidence.length === 0) fail(token, 'memory requires evidence', stateCode);
  const seenEvidence = new Set();
  for (const row of evidence) {
    const identity = `${row.conversationId}\0${row.sourceMessageId}\0${row.relation}`;
    if (seenEvidence.has(identity)) fail(token, 'memory evidence is duplicate', stateCode);
    seenEvidence.add(identity);
  }
  const requiredRelation = STATUS_RELATION[entry.status];
  if (!evidence.some((row) => row.relation === requiredRelation)) {
    fail(token, 'memory is missing its status evidence', stateCode);
  }
  if (entry.kind === 'recurrence' && (entry.status === 'candidate' || entry.status === 'active')) {
    const episodes = new Set(evidence
      .filter((row) => row.relation === 'supports' && row.supportType === 'episode_observation')
      .map((row) => row.episodeKey));
    if (episodes.size < 2) fail(token, 'recurrence needs two observations', stateCode);
  }
  return { ...entry, evidence };
}

function validateStateInternal(token, value) {
  const shapeCode = 'lifecycle_contract_invalid_shape';
  const stateCode = 'lifecycle_contract_invalid_state';
  const entry = record(token, value, STATE_FIELDS, shapeCode);
  requireString(token, entry.scenarioId, stateCode);
  if (!Number.isSafeInteger(entry.nextMemoryOrdinal) || entry.nextMemoryOrdinal < 1) {
    fail(token, 'next memory ordinal is invalid', stateCode);
  }
  const items = denseArray(token, entry.items, shapeCode).map((item) =>
    validateItemInternal(token, item));
  const keys = new Set();
  for (const item of items) {
    if (keys.has(item.memoryKey)) fail(token, 'memory key is duplicate', stateCode);
    keys.add(item.memoryKey);
  }
  return { scenarioId: entry.scenarioId, nextMemoryOrdinal: entry.nextMemoryOrdinal, items };
}

function inspectExtraction(token, value) {
  const code = 'lifecycle_contract_invalid_proposal';
  const root = record(token, value, EXTRACTION_FIELDS, code);
  const run = record(token, root.run, RUN_FIELDS, code);
  requireString(token, run.caseId, code);
  requireString(token, run.extractorVersion, code);
  const items = denseArray(token, root.items, code).map((raw) => {
    const item = record(token, raw, EXTRACTION_ITEM_FIELDS, code);
    requireString(token, item.localItemKey, code);
    if (!ITEM_KINDS.includes(item.kind)) fail(token, 'candidate kind is invalid', code);
    requireString(token, item.claim, code);
    if (item.scope !== 'conversation' && item.scope !== 'cross_conversation') {
      fail(token, 'candidate scope is invalid', code);
    }
    if (item.scope === 'conversation') {
      requireString(token, item.conversationId, code);
    } else if (item.conversationId !== null) {
      fail(token, 'candidate conversation identity is invalid', code);
    }
    if (item.sensitivity !== 'normal' && item.sensitivity !== 'sensitive') {
      fail(token, 'candidate sensitivity is invalid', code);
    }
    const statuses = [
      ...LIFECYCLE_CURRENT_STATUS_BY_KIND[item.kind],
      ...LIFECYCLE_CLOSED_STATUS_BY_KIND[item.kind],
    ];
    if (!statuses.includes(item.status)) fail(token, 'candidate status is invalid', code);
    for (const field of ['eventTimeStart', 'eventTimeEnd']) {
      if (item[field] !== null && !isValidIsoDateOrDateTime(item[field])) {
        fail(token, 'candidate event time is invalid', code);
      }
    }
    if (
      item.eventTimeStart !== null &&
      item.eventTimeEnd !== null &&
      sortableInstant(item.eventTimeStart) > sortableInstant(item.eventTimeEnd)
    ) fail(token, 'candidate event time range is invalid', code);
    if (item.kind === 'hypothesis') {
      requireString(token, item.alternative, code);
    } else if (item.alternative !== null) {
      fail(token, 'candidate alternative is invalid', code);
    }
    return { ...item };
  });
  const itemByKey = new Map();
  for (const item of items) {
    if (itemByKey.has(item.localItemKey)) fail(token, 'candidate key is duplicate', code);
    itemByKey.set(item.localItemKey, item);
  }
  const evidence = denseArray(token, root.evidence, code).map((raw) => {
    const row = record(token, raw, EXTRACTION_EVIDENCE_FIELDS, code);
    if (!itemByKey.has(row.itemKey)) fail(token, 'candidate evidence target is invalid', code);
    requireString(token, row.sourceMessageId, code);
    if (!EVIDENCE_RELATIONS.includes(row.relation)) {
      fail(token, 'candidate evidence relation is invalid', code);
    }
    if (row.provenanceRole !== 'user') {
      fail(token, 'candidate evidence must cite a user message', code);
    }
    if (!isValidIsoDateTime(row.mentionTime)) {
      fail(token, 'candidate evidence timestamp is invalid', code);
    }
    const item = itemByKey.get(row.itemKey);
    const typedSupports = item.kind === 'recurrence' && row.relation === 'supports';
    if (typedSupports) {
      if (!V2_SUPPORT_TYPES.includes(row.supportType)) {
        fail(token, 'candidate recurrence support type is invalid', code);
      }
      if (row.supportType === 'episode_observation') {
        requireString(token, row.episodeKey, code);
      } else if (row.episodeKey !== null) {
        fail(token, 'candidate recurrence support episode is invalid', code);
      }
    } else {
      if (row.supportType !== null) fail(token, 'candidate support type is invalid', code);
      requireString(token, row.episodeKey, code);
    }
    return { ...row };
  });
  const evidenceByItem = new Map(items.map((item) => [item.localItemKey, []]));
  const seenEvidence = new Set();
  for (const row of evidence) {
    const identity = `${row.itemKey}\0${row.sourceMessageId}\0${row.relation}`;
    if (seenEvidence.has(identity)) fail(token, 'candidate evidence is duplicate', code);
    seenEvidence.add(identity);
    evidenceByItem.get(row.itemKey).push(row);
  }
  for (const item of items) {
    const related = evidenceByItem.get(item.localItemKey);
    if (!related.some((row) => row.relation === STATUS_RELATION[item.status])) {
      fail(token, 'candidate is missing its status evidence', code);
    }
    if (item.kind === 'recurrence' && (item.status === 'candidate' || item.status === 'active')) {
      const episodes = new Set(related
        .filter((row) => row.relation === 'supports' && row.supportType === 'episode_observation')
        .map((row) => row.episodeKey));
      if (episodes.size < 2) fail(token, 'candidate recurrence needs two observations', code);
    }
  }
  return { run: { ...run }, items, evidence };
}

export function validateLifecycleSession(value) {
  return boundary('lifecycle_contract_invalid_shape', (token) =>
    validateSessionInternal(token, value));
}

export function validateLifecycleState(value) {
  return boundary('lifecycle_contract_invalid_shape', (token) =>
    validateStateInternal(token, value));
}

export function validateLifecycleProposal(value, context) {
  return boundary('lifecycle_contract_invalid_shape', (token) => {
    const code = 'lifecycle_contract_invalid_proposal';
    const contextEntry = record(token, context, CONTEXT_FIELDS, code);
    const state = validateStateInternal(token, contextEntry.state);
    const extraction = inspectExtraction(token, contextEntry.extraction);
    const operations = denseArray(token, value, code).map((raw) => ({
      ...record(token, raw, PROPOSAL_FIELDS, code),
    }));
    const candidateByKey = new Map(extraction.items.map((item) => [item.localItemKey, item]));
    const targetByKey = new Map(state.items.map((item) => [item.memoryKey, item]));
    const candidateKeys = new Set(candidateByKey.keys());
    const stateKeys = new Set(targetByKey.keys());
    const consumed = new Set();
    const targeted = new Map();
    for (const operation of operations) {
      if (!LIFECYCLE_OPERATION_TYPES.includes(operation.type)) {
        fail(token, 'proposal operation type is invalid', code);
      }
      if (!isNonEmptyString(operation.candidateLocalItemKey) ||
          !candidateKeys.has(operation.candidateLocalItemKey) ||
          consumed.has(operation.candidateLocalItemKey)) {
        fail(token, 'proposal candidate reference is invalid', code);
      }
      consumed.add(operation.candidateLocalItemKey);
      if (operation.type === 'create' || operation.type === 'ignore') {
        if (operation.targetMemoryKey !== null) {
          fail(token, 'proposal target must be null', code);
        }
      } else {
        if (!isMemoryKey(operation.targetMemoryKey) || !stateKeys.has(operation.targetMemoryKey)) {
          fail(token, 'proposal target reference is invalid', code);
        }
        const earlierType = targeted.get(operation.targetMemoryKey);
        if (earlierType !== undefined &&
            (earlierType !== 'confirm' || operation.type !== 'confirm')) {
          fail(token, 'proposal target is changed more than once', code);
        }
        targeted.set(operation.targetMemoryKey, operation.type);
        const candidate = candidateByKey.get(operation.candidateLocalItemKey);
        const target = targetByKey.get(operation.targetMemoryKey);
        if (!LIFECYCLE_CURRENT_STATUS_BY_KIND[target.kind].includes(target.status)) {
          fail(token, 'proposal target is already closed', code);
        }
        if (candidate.kind !== target.kind) {
          fail(token, 'proposal cannot change memory kind', code);
        }
        if (
          operation.type === 'confirm' &&
          !LIFECYCLE_CURRENT_STATUS_BY_KIND[candidate.kind].includes(candidate.status)
        ) fail(token, 'confirm candidate is already closed', code);
        if (
          operation.type === 'revise' &&
          (candidate.status === 'stale' || candidate.status === 'rejected')
        ) fail(token, 'revise cannot replace a closing operation', code);
        if (operation.type === 'mark_stale') {
          if (
            (target.kind !== 'recurrence' && target.kind !== 'hypothesis') ||
            candidate.status !== 'stale' ||
            !extraction.evidence.some((row) =>
              row.itemKey === candidate.localItemKey && row.relation === 'contradicts')
          ) fail(token, 'stale proposal is invalid', code);
        }
        if (
          operation.type === 'reject' &&
          (candidate.status !== 'rejected' ||
            !extraction.evidence.some((row) =>
              row.itemKey === candidate.localItemKey && row.relation === 'rejects'))
        ) fail(token, 'reject proposal is invalid', code);
      }
    }
    if (consumed.size !== candidateKeys.size) {
      fail(token, 'proposal must consume every candidate exactly once', code);
    }
    return operations.map((operation) => ({ ...operation }));
  });
}

export function validateForgetMemoryKeys(value, stateValue) {
  return boundary('lifecycle_contract_invalid_shape', (token) => {
    const code = 'lifecycle_contract_invalid_forget';
    const state = validateStateInternal(token, stateValue);
    const existing = new Set(state.items.map((item) => item.memoryKey));
    const entries = denseArray(token, value, code);
    const seen = new Set();
    for (const key of entries) {
      if (!isMemoryKey(key) || !existing.has(key) || seen.has(key)) {
        fail(token, 'forget key is invalid', code);
      }
      seen.add(key);
    }
    return [...entries];
  });
}

export function projectSafeLifecycleContractDiagnostic(error) {
  if (
    error === null ||
    (typeof error !== 'object' && typeof error !== 'function') ||
    !OWN_ERRORS.has(error)
  ) return null;
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(error, 'diagnosticCode');
  } catch {
    return null;
  }
  if (
    !desc ||
    typeof desc.get === 'function' ||
    typeof desc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(desc, 'value') ||
    desc.enumerable !== true ||
    !DIAGNOSTICS.has(desc.value)
  ) return null;
  return desc.value;
}
