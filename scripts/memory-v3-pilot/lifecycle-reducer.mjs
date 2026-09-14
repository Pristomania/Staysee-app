/**
 * Memory V3 synthetic lifecycle reducer.
 * Deterministic, atomic, offline, and free of provider/storage dependencies.
 */

import { createHash } from 'node:crypto';

import { canonicalStringify } from './contracts.mjs';
import {
  projectSafeLifecycleContractDiagnostic,
  validateForgetMemoryKeys,
  validateLifecycleProposal,
  validateLifecycleSession,
  validateLifecycleState,
} from './lifecycle-contract.mjs';

const OWN_ERRORS = new WeakSet();
const ERROR_TOKENS = new WeakMap();
const DIAGNOSTICS = new Set([
  'lifecycle_reducer_invalid_input',
  'lifecycle_reducer_transition_invalid',
]);
const EMPTY_FIELDS = Object.freeze(['scenarioId']);
const STEP_FIELDS = Object.freeze([
  'state',
  'session',
  'extraction',
  'proposal',
  'forgetMemoryKeys',
]);
const OPERATION_RANK = Object.freeze({
  create: 0,
  confirm: 1,
  revise: 2,
  mark_stale: 3,
  reject: 4,
  ignore: 5,
});
const MATERIAL_FIELDS = Object.freeze([
  'kind',
  'claim',
  'status',
  'sensitivity',
  'eventTimeStart',
  'eventTimeEnd',
  'alternative',
]);

function makeError(token, message, diagnosticCode) {
  const error = new Error(`[memory-v3:lifecycle-reducer] ${message}`);
  error.name = 'MemoryV3LifecycleReducerError';
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
    const contractCode = projectSafeLifecycleContractDiagnostic(error);
    const message = contractCode === null
      ? 'input has an invalid shape'
      : 'input violates the lifecycle contract';
    throw makeError(token, message, defaultDiagnostic);
  }
}

function inspectOptions(token, value, fields) {
  if (value === null || typeof value !== 'object') {
    fail(token, 'options must be a plain object', 'lifecycle_reducer_invalid_input');
  }
  let isArray;
  let prototype;
  let keys;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(token, 'options have an invalid shape', 'lifecycle_reducer_invalid_input');
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) {
    fail(token, 'options must be a plain object', 'lifecycle_reducer_invalid_input');
  }
  const allowed = new Set(fields);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      fail(token, 'options have an unknown field', 'lifecycle_reducer_invalid_input');
    }
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(token, 'options have an invalid shape', 'lifecycle_reducer_invalid_input');
    }
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value') ||
      desc.enumerable !== true ||
      desc.value === undefined
    ) fail(token, 'options have an invalid field', 'lifecycle_reducer_invalid_input');
    copy[key] = desc.value;
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      fail(token, 'options are missing a required field', 'lifecycle_reducer_invalid_input');
    }
  }
  return copy;
}

function cloneJsonData(token, value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(token, 'input contains an invalid number', 'lifecycle_reducer_invalid_input');
    }
    return value;
  }
  if (typeof value !== 'object') {
    fail(token, 'input is not JSON data', 'lifecycle_reducer_invalid_input');
  }
  if (seen.has(value)) {
    fail(token, 'input contains a cycle', 'lifecycle_reducer_invalid_input');
  }
  seen.add(value);
  let isArray;
  let prototype;
  let keys;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(token, 'input has an invalid shape', 'lifecycle_reducer_invalid_input');
  }
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    fail(token, 'input must use plain objects', 'lifecycle_reducer_invalid_input');
  }
  const copy = isArray ? [] : {};
  let length = 0;
  if (isArray) {
    let lengthDesc;
    try {
      lengthDesc = Object.getOwnPropertyDescriptor(value, 'length');
    } catch {
      fail(token, 'input array has an invalid shape', 'lifecycle_reducer_invalid_input');
    }
    if (!lengthDesc || !Object.prototype.hasOwnProperty.call(lengthDesc, 'value')) {
      fail(token, 'input array has an invalid shape', 'lifecycle_reducer_invalid_input');
    }
    length = lengthDesc.value;
  }
  const allowedArrayKeys = new Set(['length']);
  for (let index = 0; index < length; index += 1) allowedArrayKeys.add(String(index));
  for (const key of keys) {
    if (typeof key === 'symbol' || (isArray && !allowedArrayKeys.has(key))) {
      fail(token, 'input has an invalid field', 'lifecycle_reducer_invalid_input');
    }
    if (key === 'length') continue;
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(token, 'input has an invalid shape', 'lifecycle_reducer_invalid_input');
    }
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value') ||
      desc.enumerable !== true ||
      desc.value === undefined
    ) fail(token, 'input has an invalid field', 'lifecycle_reducer_invalid_input');
    copy[key] = cloneJsonData(token, desc.value, seen);
  }
  if (isArray && copy.length !== length) {
    fail(token, 'input must use dense arrays', 'lifecycle_reducer_invalid_input');
  }
  seen.delete(value);
  return copy;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function memoryKeyFor(scenarioId, ordinal) {
  const payload = canonicalStringify({
    namespace: 'memory-v3-synthetic-lifecycle-v1',
    scenarioId,
    ordinal,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function materialFromCandidate(candidate) {
  const material = {};
  for (const field of MATERIAL_FIELDS) material[field] = candidate[field];
  return material;
}

function evidenceIdentity(row) {
  return `${row.conversationId}\0${row.sourceMessageId}\0${row.relation}`;
}

function compareEvidence(left, right) {
  return compareStrings(evidenceIdentity(left), evidenceIdentity(right));
}

function candidateEvidence(extraction, candidateLocalItemKey, conversationId) {
  return extraction.evidence
    .filter((row) => row.itemKey === candidateLocalItemKey)
    .map((row) => ({
      conversationId,
      sourceMessageId: row.sourceMessageId,
      relation: row.relation,
      supportType: row.supportType,
      episodeKey: row.episodeKey,
      provenanceRole: row.provenanceRole,
      mentionTime: row.mentionTime,
    }))
    .sort(compareEvidence);
}

function mergeEvidence(token, existing, incoming) {
  const byIdentity = new Map(existing.map((row) => [evidenceIdentity(row), { ...row }]));
  for (const row of incoming) {
    const identity = evidenceIdentity(row);
    const previous = byIdentity.get(identity);
    if (previous === undefined) {
      byIdentity.set(identity, { ...row });
      continue;
    }
    if (canonicalStringify(previous) !== canonicalStringify(row)) {
      fail(token, 'evidence identity conflicts with existing state', 'lifecycle_reducer_transition_invalid');
    }
  }
  return [...byIdentity.values()].sort(compareEvidence);
}

function cloneStateItem(item) {
  return { ...item, evidence: item.evidence.map((row) => ({ ...row })) };
}

function operationComparator(left, right) {
  const rankDelta = OPERATION_RANK[left.type] - OPERATION_RANK[right.type];
  if (rankDelta !== 0) return rankDelta;
  const targetDelta = compareStrings(left.targetMemoryKey ?? '', right.targetMemoryKey ?? '');
  if (targetDelta !== 0) return targetDelta;
  return compareStrings(left.candidateLocalItemKey, right.candidateLocalItemKey);
}

export function createEmptyLifecycleState(options) {
  return boundary('lifecycle_reducer_invalid_input', (token) => {
    const projected = inspectOptions(token, options, EMPTY_FIELDS);
    if (typeof projected.scenarioId !== 'string' || projected.scenarioId.trim().length === 0) {
      fail(token, 'scenarioId must be a non-empty string', 'lifecycle_reducer_invalid_input');
    }
    return deepFreeze({
      scenarioId: projected.scenarioId,
      nextMemoryOrdinal: 1,
      items: [],
    });
  });
}

export function applyLifecycleStep(options) {
  return boundary('lifecycle_reducer_invalid_input', (token) => {
    const projected = inspectOptions(token, options, STEP_FIELDS);
    const originalState = validateLifecycleState(projected.state);
    const session = validateLifecycleSession(projected.session);
    if (originalState.scenarioId !== session.scenarioId) {
      fail(token, 'state and session scenarioId must match', 'lifecycle_reducer_invalid_input');
    }
    const extraction = cloneJsonData(token, projected.extraction);
    const run = extraction !== null && typeof extraction === 'object'
      ? Object.getOwnPropertyDescriptor(extraction, 'run')
      : undefined;
    const caseId = run?.value !== null && typeof run?.value === 'object'
      ? Object.getOwnPropertyDescriptor(run.value, 'caseId')
      : undefined;
    if (!caseId || caseId.value !== session.stepId) {
      fail(token, 'extraction caseId must match session stepId', 'lifecycle_reducer_invalid_input');
    }

    const forgetMemoryKeys = validateForgetMemoryKeys(
      projected.forgetMemoryKeys,
      originalState,
    );
    const forgotten = new Set(forgetMemoryKeys);
    const working = {
      scenarioId: originalState.scenarioId,
      nextMemoryOrdinal: originalState.nextMemoryOrdinal,
      items: originalState.items
        .filter((item) => !forgotten.has(item.memoryKey))
        .map(cloneStateItem),
    };
    validateLifecycleState(working);
    const proposal = validateLifecycleProposal(projected.proposal, {
      state: working,
      extraction,
    }).sort(operationComparator);
    const candidateByKey = new Map(extraction.items.map((item) => [item.localItemKey, item]));
    const transitions = [...forgetMemoryKeys]
      .sort(compareStrings)
      .map((memoryKey) => ({
        type: 'forget',
        candidateLocalItemKey: null,
        targetMemoryKey: memoryKey,
        resultingMemoryKey: null,
      }));

    for (const operation of proposal) {
      const candidate = candidateByKey.get(operation.candidateLocalItemKey);
      const incomingEvidence = candidateEvidence(
        extraction,
        operation.candidateLocalItemKey,
        session.conversationId,
      );
      let resultingMemoryKey = operation.targetMemoryKey;
      if (operation.type === 'create') {
        resultingMemoryKey = memoryKeyFor(working.scenarioId, working.nextMemoryOrdinal);
        if (working.items.some((item) => item.memoryKey === resultingMemoryKey)) {
          fail(token, 'generated memory key collides', 'lifecycle_reducer_transition_invalid');
        }
        working.items.push({
          memoryKey: resultingMemoryKey,
          ...materialFromCandidate(candidate),
          firstSeenAt: session.at,
          updatedAt: session.at,
          revision: 1,
          evidence: incomingEvidence,
        });
        working.nextMemoryOrdinal += 1;
      } else if (operation.type !== 'ignore') {
        const index = working.items.findIndex((item) => item.memoryKey === operation.targetMemoryKey);
        if (index < 0) {
          fail(token, 'proposal target disappeared', 'lifecycle_reducer_transition_invalid');
        }
        const target = working.items[index];
        if (Date.parse(session.at) < Date.parse(target.updatedAt)) {
          fail(token, 'session timestamp precedes target update', 'lifecycle_reducer_transition_invalid');
        }
        const mergedEvidence = mergeEvidence(token, target.evidence, incomingEvidence);
        if (operation.type === 'confirm') {
          working.items[index] = { ...target, evidence: mergedEvidence };
        } else if (operation.type === 'revise') {
          working.items[index] = {
            ...target,
            ...materialFromCandidate(candidate),
            updatedAt: session.at,
            revision: target.revision + 1,
            evidence: mergedEvidence,
          };
        } else {
          working.items[index] = {
            ...target,
            status: candidate.status,
            updatedAt: session.at,
            revision: target.revision + 1,
            evidence: mergedEvidence,
          };
        }
      }
      transitions.push({
        type: operation.type,
        candidateLocalItemKey: operation.candidateLocalItemKey,
        targetMemoryKey: operation.targetMemoryKey,
        resultingMemoryKey: operation.type === 'ignore' ? null : resultingMemoryKey,
      });
    }

    working.items.sort((left, right) => compareStrings(left.memoryKey, right.memoryKey));
    const state = validateLifecycleState(working);
    return deepFreeze({ state, transitions });
  });
}

export function projectSafeLifecycleReducerDiagnostic(error) {
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
