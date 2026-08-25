/**
 * Memory V3 V2 contract — layered gold tiers and typed recurrence evidence.
 * Pure validation. No network, filesystem, env, or V1 validateCase/validateExtraction.
 */

import { ITEM_KINDS, EVIDENCE_RELATIONS, canonicalStringify } from './contracts.mjs';

export const V2_SUPPORT_TYPES = Object.freeze([
  'episode_observation',
  'pattern_confirmation',
  'scope_boundary',
]);
export const V2_ADAPTER_EVIDENCE_FIELDS = Object.freeze([
  'itemRef',
  'sourceMessageId',
  'relation',
  'supportType',
  'episodeKey',
]);
export const V2_GOLD_TIERS = Object.freeze(['required', 'acceptable']);

const CONTRACT_PREFIX = '[memory-v3:v2-contract]';
const MESSAGE_ROLES = new Set(['user', 'assistant', 'system']);
const SCOPES = new Set(['conversation', 'cross_conversation']);
const SENSITIVITIES = new Set(['normal', 'sensitive']);
const STATUS_BY_KIND = Object.freeze({
  event: new Set(['active', 'corrected', 'rejected']),
  recurrence: new Set(['candidate', 'active', 'stale', 'rejected']),
  hypothesis: new Set(['candidate', 'supported', 'stale', 'rejected']),
});
const FORBIDDEN_ITEM_TREE_KEYS = new Set([
  'reasoning',
  'rationale',
  'chainOfThought',
  'chain_of_thought',
  'diagnosis',
  'clinicalLabel',
  'clinical_label',
  'attachmentStyle',
  'attachment_style',
  'mentionTime',
]);
const REQUIRED_USER_RELATION_BY_KIND_STATUS = Object.freeze({
  event: Object.freeze({
    active: 'supports',
    corrected: 'corrects',
    rejected: 'rejects',
  }),
  recurrence: Object.freeze({
    candidate: 'supports',
    active: 'supports',
    stale: 'contradicts',
    rejected: 'rejects',
  }),
  hypothesis: Object.freeze({
    candidate: 'supports',
    supported: 'supports',
    stale: 'contradicts',
    rejected: 'rejects',
  }),
});
const CASE_REQUIRED = Object.freeze(['caseId', 'messages', 'gold']);
const CASE_OPTIONAL = Object.freeze(['title', 'category', 'mustNotRemember']);
const MESSAGE_FIELDS = Object.freeze(['id', 'role', 'text', 'createdAt']);
const GOLD_FIELDS = Object.freeze(['required', 'acceptable']);
const TIER_FIELDS = Object.freeze(['events', 'recurrences', 'hypotheses']);
const GOLD_ITEM_REQUIRED = Object.freeze(['goldItemId', 'claim']);
const GOLD_ITEM_OPTIONAL = Object.freeze([
  'status',
  'sensitivity',
  'eventTimeStart',
  'eventTimeEnd',
  'alternative',
  'mustNotBeFact',
  'supportMessageIds',
  'supportTypes',
  'episodeKeys',
  'correctedMessageIds',
  'contradictedMessageIds',
  'rejectedMessageIds',
]);
const EXTRACTION_FIELDS = Object.freeze(['run', 'items', 'evidence']);
const RUN_FIELDS = Object.freeze(['caseId', 'extractorVersion']);
const ITEM_FIELDS = Object.freeze([
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
const KIND_LIST = Object.freeze(['event', 'recurrence', 'hypothesis']);
const KIND_TO_LIST = Object.freeze({
  event: 'events',
  recurrence: 'recurrences',
  hypothesis: 'hypotheses',
});

function fail(message) {
  throw new Error(`${CONTRACT_PREFIX} ${message}`);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRealCalendarDate(year, month, day) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function isValidTimeComponents(hour, minute, second) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) {
    return false;
  }
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

function isValidUtcOffset(sign, hour, minute) {
  if (sign !== '+' && sign !== '-') return false;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  if (hour < 0 || hour > 14 || minute < 0 || minute > 59) return false;
  if (hour === 14 && minute !== 0) return false;
  return true;
}

function isValidIsoDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const s = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(
    s,
  );
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (!isRealCalendarDate(year, month, day)) return false;
  if (!isValidTimeComponents(hour, minute, second)) return false;
  const tz = m[8];
  if (tz !== 'Z') {
    const om = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
    if (!om) return false;
    if (!isValidUtcOffset(om[1], Number(om[2]), Number(om[3]))) return false;
  }
  return Number.isFinite(Date.parse(s));
}

function isValidIsoDateOrDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const s = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    return isRealCalendarDate(
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
    );
  }
  return isValidIsoDateTime(s);
}

function toSortableInstant(value) {
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00.000Z`);
  return Date.parse(s);
}

function inspectPlainObject(value, path) {
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    fail(`${path} must be a plain object`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be a plain object`);
  }
  if (proto !== Object.prototype && proto !== null) {
    fail(`${path} must be a plain object`);
  }
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${path} has an invalid shape`);
  }
  return keys;
}

function dataDescriptor(value, key, path) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail(`${path} has an invalid shape`);
  }
  if (
    !desc ||
    typeof desc.get === 'function' ||
    typeof desc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(desc, 'value') ||
    desc.enumerable !== true
  ) {
    fail(`${path} has an invalid field`);
  }
  if (desc.value === undefined) {
    fail(`${path} is missing a required field`);
  }
  return desc;
}

function inspectRecord(value, allowed, path) {
  const keys = inspectPlainObject(value, path);
  const allowedSet = new Set(allowed);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowedSet.has(key)) {
      fail(`${path} has an unknown field`);
    }
    copy[key] = dataDescriptor(value, key, path).value;
  }
  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      fail(`${path} is missing a required field`);
    }
  }
  return copy;
}

function inspectRecordPartial(value, required, optional, path) {
  const keys = inspectPlainObject(value, path);
  const allowedSet = new Set([...required, ...optional]);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowedSet.has(key)) {
      fail(`${path} has an unknown field`);
    }
    copy[key] = dataDescriptor(value, key, path).value;
  }
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      fail(`${path} is missing a required field`);
    }
  }
  return copy;
}

function inspectDenseArray(value, path) {
  if (!Array.isArray(value)) fail(`${path} must be a dense array`);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${path} must be a dense array`);
  }
  const length = value.length;
  const allowed = new Set(['length']);
  for (let i = 0; i < length; i += 1) allowed.add(String(i));
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      fail(`${path} has an unknown field`);
    }
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(`${path} has an invalid shape`);
    }
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value')
    ) {
      fail(`${path} has an invalid field`);
    }
    if (key !== 'length' && desc.enumerable !== true) {
      fail(`${path} has an invalid field`);
    }
  }
  const entries = [];
  for (let i = 0; i < length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(value, i);
    if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
      fail(`${path} must be a dense array`);
    }
    entries.push(desc.value);
  }
  return entries;
}

function inspectStringIdArray(value, path) {
  const entries = inspectDenseArray(value, path);
  const seen = new Set();
  for (let i = 0; i < entries.length; i += 1) {
    if (!isNonEmptyString(entries[i])) fail(`${path}[${i}] is invalid`);
    if (seen.has(entries[i])) fail(`${path} values must be unique`);
    seen.add(entries[i]);
  }
  return entries;
}

function inspectOptionalIdArray(entry, field, path) {
  if (!Object.prototype.hasOwnProperty.call(entry, field)) return [];
  return inspectStringIdArray(entry[field], `${path}.${field}`);
}

function normalizeClaim(claim) {
  if (typeof claim !== 'string') return '';
  return claim.normalize('NFC').trim();
}

function sortedCopy(ids) {
  return [...ids].sort();
}

function observationPartition(supportMessageIds, supportTypes, episodeKeys) {
  const groups = new Map();
  for (let i = 0; i < supportMessageIds.length; i += 1) {
    if (supportTypes[i] !== 'episode_observation') continue;
    const episodeKey = episodeKeys[i];
    if (!groups.has(episodeKey)) groups.set(episodeKey, []);
    groups.get(episodeKey).push(supportMessageIds[i]);
  }
  const parts = [...groups.values()].map((ids) => sortedCopy(ids));
  parts.sort((left, right) => left.join('\0').localeCompare(right.join('\0')));
  return parts;
}

function goldFingerprint(kind, entry) {
  const supportMessageIds = Array.isArray(entry.supportMessageIds)
    ? entry.supportMessageIds
    : [];
  const supportTypes = Array.isArray(entry.supportTypes) ? entry.supportTypes : [];
  const episodeKeys = Array.isArray(entry.episodeKeys) ? entry.episodeKeys : [];
  const supportTypeById = {};
  for (let i = 0; i < supportMessageIds.length; i += 1) {
    supportTypeById[supportMessageIds[i]] = supportTypes[i] ?? null;
  }
  return canonicalStringify({
    kind,
    claim: normalizeClaim(entry.claim),
    status: entry.status ?? null,
    sensitivity: entry.sensitivity ?? null,
    eventTimeStart: entry.eventTimeStart ?? null,
    eventTimeEnd: entry.eventTimeEnd ?? null,
    alternative: entry.alternative ?? null,
    supportMessageIds: sortedCopy(supportMessageIds),
    correctedMessageIds: sortedCopy(entry.correctedMessageIds ?? []),
    contradictedMessageIds: sortedCopy(entry.contradictedMessageIds ?? []),
    rejectedMessageIds: sortedCopy(entry.rejectedMessageIds ?? []),
    supportTypeById,
    episodePartition: observationPartition(supportMessageIds, supportTypes, episodeKeys),
  });
}

function assertNoForbiddenKeys(value, path) {
  if (Array.isArray(value)) {
    const entries = inspectDenseArray(value, path);
    entries.forEach((entry, index) => assertNoForbiddenKeys(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const keys = inspectPlainObject(value, path);
  for (const key of keys) {
    if (typeof key === 'symbol') fail(`${path} has an invalid field`);
    if (FORBIDDEN_ITEM_TREE_KEYS.has(key)) fail(`${path} has a forbidden field`);
    const desc = dataDescriptor(value, key, path);
    assertNoForbiddenKeys(desc.value, `${path}.${key}`);
  }
}

function validateMessage(raw, index, seenIds, messageById) {
  const path = `messages[${index}]`;
  const message = inspectRecord(raw, MESSAGE_FIELDS, path);
  if (!isNonEmptyString(message.id)) fail(`${path}.id is invalid`);
  if (seenIds.has(message.id)) fail(`${path}.id is duplicate`);
  seenIds.add(message.id);
  if (!MESSAGE_ROLES.has(message.role)) fail(`${path}.role is invalid`);
  if (typeof message.text !== 'string') fail(`${path}.text is invalid`);
  if (!isValidIsoDateTime(message.createdAt)) fail(`${path}.createdAt is invalid`);
  messageById.set(message.id, message);
  return message;
}

function validateGoldIdList(ids, path, messageById, { userOnly }) {
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const message = messageById.get(id);
    if (!message) fail(`${path}[${i}] references an unknown message`);
    if (userOnly && message.role !== 'user') fail(`${path}[${i}] must cite a user message`);
  }
}

function validateGoldItem(raw, kind, path, messageById) {
  const entry = inspectRecordPartial(raw, GOLD_ITEM_REQUIRED, GOLD_ITEM_OPTIONAL, path);
  if (!isNonEmptyString(entry.goldItemId)) fail(`${path}.goldItemId is invalid`);
  if (!isNonEmptyString(entry.claim)) fail(`${path}.claim is invalid`);

  for (const field of ['eventTimeStart', 'eventTimeEnd']) {
    if (entry[field] == null) continue;
    if (!isValidIsoDateOrDateTime(entry[field])) fail(`${path}.${field} is invalid`);
  }
  if (entry.eventTimeStart != null && entry.eventTimeEnd != null) {
    if (toSortableInstant(entry.eventTimeStart) > toSortableInstant(entry.eventTimeEnd)) {
      fail(`${path} eventTimeStart must not be later than eventTimeEnd`);
    }
  }

  if (entry.status != null && !STATUS_BY_KIND[kind].has(entry.status)) {
    fail(`${path}.status is invalid`);
  }
  if (entry.sensitivity != null && !SENSITIVITIES.has(entry.sensitivity)) {
    fail(`${path}.sensitivity is invalid`);
  }

  if (kind === 'hypothesis') {
    if (!isNonEmptyString(entry.alternative)) fail(`${path}.alternative is required`);
    if (entry.mustNotBeFact !== true) fail(`${path}.mustNotBeFact is required`);
  } else {
    if (entry.alternative != null) fail(`${path}.alternative must be null`);
    if (entry.mustNotBeFact != null) fail(`${path}.mustNotBeFact must be null`);
  }

  const supportMessageIds = inspectOptionalIdArray(entry, 'supportMessageIds', path);
  const correctedMessageIds = inspectOptionalIdArray(entry, 'correctedMessageIds', path);
  const contradictedMessageIds = inspectOptionalIdArray(entry, 'contradictedMessageIds', path);
  const rejectedMessageIds = inspectOptionalIdArray(entry, 'rejectedMessageIds', path);
  entry.supportMessageIds = supportMessageIds;
  entry.correctedMessageIds = correctedMessageIds;
  entry.contradictedMessageIds = contradictedMessageIds;
  entry.rejectedMessageIds = rejectedMessageIds;

  validateGoldIdList(supportMessageIds, `${path}.supportMessageIds`, messageById, {
    userOnly: true,
  });
  validateGoldIdList(correctedMessageIds, `${path}.correctedMessageIds`, messageById, {
    userOnly: true,
  });
  validateGoldIdList(contradictedMessageIds, `${path}.contradictedMessageIds`, messageById, {
    userOnly: true,
  });
  validateGoldIdList(rejectedMessageIds, `${path}.rejectedMessageIds`, messageById, {
    userOnly: true,
  });

  if (kind !== 'recurrence') {
    if (Object.prototype.hasOwnProperty.call(entry, 'supportTypes')) {
      fail(`${path}.supportTypes is not allowed`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'episodeKeys')) {
      fail(`${path}.episodeKeys is not allowed`);
    }
    return entry;
  }

  if (!Object.prototype.hasOwnProperty.call(entry, 'supportTypes')) {
    fail(`${path}.supportTypes is required`);
  }
  if (!Object.prototype.hasOwnProperty.call(entry, 'episodeKeys')) {
    fail(`${path}.episodeKeys is required`);
  }
  const supportTypes = inspectDenseArray(entry.supportTypes, `${path}.supportTypes`);
  const episodeKeys = inspectDenseArray(entry.episodeKeys, `${path}.episodeKeys`);
  if (
    supportTypes.length !== supportMessageIds.length ||
    episodeKeys.length !== supportMessageIds.length
  ) {
    fail(`${path} supportTypes and episodeKeys length must match supportMessageIds`);
  }
  const observationKeys = new Set();
  for (let i = 0; i < supportTypes.length; i += 1) {
    if (!V2_SUPPORT_TYPES.includes(supportTypes[i])) {
      fail(`${path}.supportTypes[${i}] is invalid`);
    }
    if (supportTypes[i] === 'episode_observation') {
      if (!isNonEmptyString(episodeKeys[i])) fail(`${path}.episodeKeys[${i}] is invalid`);
      observationKeys.add(episodeKeys[i]);
    } else if (episodeKeys[i] !== null) {
      fail(`${path}.episodeKeys[${i}] must be null`);
    }
  }
  if (observationKeys.size < 2) {
    fail(`${path} requires at least two distinct episode observations`);
  }
  entry.supportTypes = supportTypes;
  entry.episodeKeys = episodeKeys;
  return entry;
}

export function validateCaseV2(caseData) {
  const projected = inspectRecordPartial(caseData, CASE_REQUIRED, CASE_OPTIONAL, 'case');
  if (!isNonEmptyString(projected.caseId)) fail('case.caseId is invalid');
  const messages = inspectDenseArray(projected.messages, 'case.messages');
  const seenIds = new Set();
  const messageById = new Map();
  projected.messages = messages.map((message, index) =>
    validateMessage(message, index, seenIds, messageById),
  );

  const gold = inspectRecord(projected.gold, GOLD_FIELDS, 'case.gold');
  const seenGoldIds = new Set();
  const seenFingerprints = new Set();

  for (const tier of V2_GOLD_TIERS) {
    const tierValue = inspectRecord(gold[tier], TIER_FIELDS, `case.gold.${tier}`);
    gold[tier] = tierValue;
    for (const kind of KIND_LIST) {
      const listName = KIND_TO_LIST[kind];
      const list = inspectDenseArray(tierValue[listName], `case.gold.${tier}.${listName}`);
      const validated = list.map((raw, index) => {
        const path = `case.gold.${tier}.${listName}[${index}]`;
        const entry = validateGoldItem(raw, kind, path, messageById);
        if (seenGoldIds.has(entry.goldItemId)) fail(`${path}.goldItemId is duplicate`);
        seenGoldIds.add(entry.goldItemId);
        const fingerprint = goldFingerprint(kind, entry);
        if (seenFingerprints.has(fingerprint)) fail(`${path} duplicates another gold item`);
        seenFingerprints.add(fingerprint);
        return entry;
      });
      tierValue[listName] = validated;
    }
  }

  projected.gold = gold;
  return projected;
}

export function goldItemsV2(caseData) {
  const validated = validateCaseV2(caseData);
  const items = [];
  for (const tier of V2_GOLD_TIERS) {
    for (const kind of KIND_LIST) {
      const listName = KIND_TO_LIST[kind];
      validated.gold[tier][listName].forEach((entry, index) => {
        items.push({
          goldItemId: entry.goldItemId,
          tier,
          kind,
          index,
          entry,
        });
      });
    }
  }
  return items;
}

function validateExtractionItem(raw, index, seenKeys) {
  const path = `items[${index}]`;
  assertNoForbiddenKeys(raw, path);
  const item = inspectRecord(raw, ITEM_FIELDS, path);
  if (!isNonEmptyString(item.localItemKey)) fail(`${path}.localItemKey is invalid`);
  if (seenKeys.has(item.localItemKey)) fail(`${path}.localItemKey is duplicate`);
  seenKeys.add(item.localItemKey);
  if (!ITEM_KINDS.includes(item.kind)) fail(`${path}.kind is invalid`);
  if (!isNonEmptyString(item.claim)) fail(`${path}.claim is invalid`);
  if (!SCOPES.has(item.scope)) fail(`${path}.scope is invalid`);
  if (item.scope === 'conversation') {
    if (!isNonEmptyString(item.conversationId)) fail(`${path}.conversationId is invalid`);
  } else if (item.conversationId !== null) {
    fail(`${path}.conversationId must be null`);
  }
  if (!SENSITIVITIES.has(item.sensitivity)) fail(`${path}.sensitivity is invalid`);
  if (!STATUS_BY_KIND[item.kind].has(item.status)) fail(`${path}.status is invalid`);
  for (const field of ['eventTimeStart', 'eventTimeEnd']) {
    if (item[field] == null) continue;
    if (!isValidIsoDateOrDateTime(item[field])) fail(`${path}.${field} is invalid`);
  }
  if (item.eventTimeStart != null && item.eventTimeEnd != null) {
    if (toSortableInstant(item.eventTimeStart) > toSortableInstant(item.eventTimeEnd)) {
      fail(`${path} eventTimeStart must not be later than eventTimeEnd`);
    }
  }
  if (item.kind === 'hypothesis') {
    if (!isNonEmptyString(item.alternative)) fail(`${path}.alternative is required`);
  } else if (item.alternative !== null) {
    fail(`${path}.alternative must be null`);
  }
  return item;
}

function validateExtractionEvidence(raw, index, itemByKey, messageById) {
  const path = `evidence[${index}]`;
  const entry = inspectRecord(raw, EXTRACTION_EVIDENCE_FIELDS, path);
  if (!itemByKey.has(entry.itemKey)) fail(`${path}.itemKey is unknown`);
  if (!EVIDENCE_RELATIONS.includes(entry.relation)) fail(`${path}.relation is invalid`);
  if (entry.provenanceRole !== 'user') fail(`${path} must cite a user message`);
  if (!isValidIsoDateTime(entry.mentionTime)) fail(`${path}.mentionTime is invalid`);
  if (!isNonEmptyString(entry.sourceMessageId)) fail(`${path}.sourceMessageId is invalid`);

  const item = itemByKey.get(entry.itemKey);
  const typedSupports = item.kind === 'recurrence' && entry.relation === 'supports';
  if (typedSupports) {
    if (!V2_SUPPORT_TYPES.includes(entry.supportType)) fail(`${path}.supportType is invalid`);
    if (entry.supportType === 'episode_observation') {
      if (!isNonEmptyString(entry.episodeKey)) fail(`${path}.episodeKey is invalid`);
    } else if (entry.episodeKey !== null) {
      fail(`${path}.episodeKey must be null`);
    }
  } else {
    if (entry.supportType !== null) fail(`${path}.supportType must be null`);
    if (!isNonEmptyString(entry.episodeKey)) fail(`${path}.episodeKey is invalid`);
  }

  if (messageById) {
    const message = messageById.get(entry.sourceMessageId);
    if (!message) fail(`${path}.sourceMessageId is unknown`);
    if (message.role !== 'user' || message.role !== entry.provenanceRole) {
      fail(`${path} must cite a user message`);
    }
  }
  return entry;
}

function assertRequiredEvidence(item, index, related) {
  if (related.length === 0) fail(`items[${index}] requires related evidence`);
  const required = REQUIRED_USER_RELATION_BY_KIND_STATUS[item.kind]?.[item.status];
  if (required) {
    const hasRequired = related.some(
      (entry) => entry.relation === required && entry.provenanceRole === 'user',
    );
    if (!hasRequired) fail(`items[${index}] requires the status relation`);
  }
  if (item.kind !== 'recurrence') return;
  if (item.status !== 'candidate' && item.status !== 'active') return;
  const observationKeys = new Set();
  for (const entry of related) {
    if (
      entry.relation === 'supports' &&
      entry.provenanceRole === 'user' &&
      entry.supportType === 'episode_observation'
    ) {
      observationKeys.add(entry.episodeKey);
    }
  }
  if (observationKeys.size < 2) {
    fail(`items[${index}] requires at least two distinct episode observations`);
  }
}

export function validateExtractionV2(extraction, caseData) {
  let messageById = null;
  const projected = inspectRecord(extraction, EXTRACTION_FIELDS, 'extraction');
  const run = inspectRecord(projected.run, RUN_FIELDS, 'extraction.run');
  if (!isNonEmptyString(run.caseId)) fail('extraction.run.caseId is invalid');
  if (!isNonEmptyString(run.extractorVersion)) {
    fail('extraction.run.extractorVersion is invalid');
  }

  if (caseData !== undefined && caseData !== null) {
    const validatedCase = validateCaseV2(caseData);
    if (run.caseId !== validatedCase.caseId) fail('extraction.run.caseId does not match case');
    messageById = new Map(validatedCase.messages.map((message) => [message.id, message]));
  }

  const itemsRaw = inspectDenseArray(projected.items, 'extraction.items');
  const evidenceRaw = inspectDenseArray(projected.evidence, 'extraction.evidence');
  const seenKeys = new Set();
  const items = itemsRaw.map((raw, index) => validateExtractionItem(raw, index, seenKeys));
  const itemByKey = new Map(items.map((item) => [item.localItemKey, item]));

  const seenEvidence = new Set();
  const evidence = evidenceRaw.map((raw, index) => {
    const entry = validateExtractionEvidence(raw, index, itemByKey, messageById);
    const dupKey = `${entry.itemKey}\0${entry.sourceMessageId}\0${entry.relation}`;
    if (seenEvidence.has(dupKey)) fail(`evidence[${index}] is duplicate`);
    seenEvidence.add(dupKey);
    return entry;
  });

  items.forEach((item, index) => {
    const related = evidence.filter((entry) => entry.itemKey === item.localItemKey);
    assertRequiredEvidence(item, index, related);
  });

  return {
    run,
    items,
    evidence,
  };
}
