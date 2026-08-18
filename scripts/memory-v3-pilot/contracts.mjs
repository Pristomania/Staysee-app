/**
 * StaySEE Memory V3 offline pilot — epistemic contract.
 * Pure validation + deterministic keys. No network, no DB, no app runtime.
 */

import { createHash } from 'node:crypto';

export const ITEM_KINDS = Object.freeze(['event', 'recurrence', 'hypothesis']);
export const EVIDENCE_RELATIONS = Object.freeze([
  'supports',
  'contradicts',
  'corrects',
  'rejects',
]);

const PROVENANCE_ROLES = new Set(['user', 'assistant', 'system']);
const SCOPES = new Set(['conversation', 'cross_conversation']);
const SENSITIVITIES = new Set(['normal', 'sensitive']);

const STATUS_BY_KIND = Object.freeze({
  event: new Set(['active', 'corrected', 'rejected']),
  recurrence: new Set(['candidate', 'active', 'stale', 'rejected']),
  hypothesis: new Set(['candidate', 'supported', 'stale', 'rejected']),
});

/** Forbidden anywhere inside an item tree (including nested objects). */
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

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * True only when year/month/day form a real Gregorian calendar date (no Date.parse rollover).
 */
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
  // ISO offsets are within ±14:00. Hours 0–13 allow minutes 00–59; hour 14 allows only 00.
  if (hour < 0 || hour > 14 || minute < 0 || minute > 59) return false;
  if (hour === 14 && minute !== 0) return false;
  return true;
}

/**
 * Instant with unambiguous timezone: YYYY-MM-DDTHH:MM[:SS[.fff]](Z|±HH:MM)
 * Rejects space instead of T and dates that Date.parse would normalize.
 */
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

/**
 * Strict calendar date YYYY-MM-DD, or the same strict ISO datetime required for instants.
 * Does not accept a space in place of T.
 */
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

function assertNoForbiddenKeys(value, path, extraForbidden = null) {
  if (Array.isArray(value)) {
    value.forEach((entry, i) =>
      assertNoForbiddenKeys(entry, `${path}[${i}]`, extraForbidden),
    );
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_ITEM_TREE_KEYS.has(key) || (extraForbidden && extraForbidden.has(key))) {
      fail(`Forbidden field "${key}" at ${path}.${key}`);
    }
    assertNoForbiddenKeys(child, `${path}.${key}`, extraForbidden);
  }
}

function collectGoldMessageIds(goldEntry) {
  const ids = [];
  if (!isPlainObject(goldEntry)) return ids;
  for (const field of [
    'supportMessageIds',
    'correctedMessageIds',
    'contradictedMessageIds',
    'rejectedMessageIds',
  ]) {
    const arr = goldEntry[field];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) fail(`gold.${field} must be an array`);
    for (const id of arr) {
      if (!isNonEmptyString(id)) fail(`gold.${field} entries must be non-empty strings`);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Stable recursive canonical JSON:
 * - object keys sorted
 * - array order preserved
 */
export function canonicalStringify(value) {
  return stringifyCanonical(value);
}

function stringifyCanonical(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value)) fail('canonical JSON cannot include non-finite numbers');
    return String(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'undefined') fail('canonical JSON cannot include undefined');
  if (Array.isArray(value)) {
    return `[${value.map((v) => stringifyCanonical(v)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stringifyCanonical(value[k])}`)
      .join(',')}}`;
  }
  fail(`canonical JSON unsupported type: ${t}`);
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function makeRunKey(input) {
  if (!isPlainObject(input)) fail('makeRunKey input must be an object');
  if (!isNonEmptyString(input.caseId)) fail('makeRunKey requires non-empty caseId');
  if (!isNonEmptyString(input.extractorVersion)) {
    fail('makeRunKey requires non-empty extractorVersion');
  }
  const payload = {
    caseId: input.caseId,
    extractorVersion: input.extractorVersion,
  };
  return sha256Hex(stringifyCanonical(payload));
}

export function makeLocalItemKey(item, index) {
  if (!isPlainObject(item)) fail('makeLocalItemKey item must be an object');
  if (!Number.isInteger(index) || index < 0) {
    fail('makeLocalItemKey index must be a non-negative integer');
  }
  const structural = {
    index,
    kind: item.kind ?? null,
    scope: item.scope ?? null,
    conversationId: item.conversationId ?? null,
    claim: item.claim ?? null,
    status: item.status ?? null,
    sensitivity: item.sensitivity ?? null,
    eventTimeStart: item.eventTimeStart ?? null,
    eventTimeEnd: item.eventTimeEnd ?? null,
    alternative: item.alternative ?? null,
  };
  return sha256Hex(stringifyCanonical(structural));
}

function validateRun(run) {
  if (!isPlainObject(run)) fail('extraction.run must be an object');
  if (!isNonEmptyString(run.caseId)) fail('run.caseId must be a non-empty string');
  if (!isNonEmptyString(run.extractorVersion)) {
    fail('run.extractorVersion must be a non-empty string');
  }
}

function validateItem(item, index, seenKeys) {
  if (!isPlainObject(item)) fail(`items[${index}] must be an object`);

  assertNoForbiddenKeys(item, `items[${index}]`);

  if (!isNonEmptyString(item.localItemKey)) {
    fail(`items[${index}].localItemKey must be a non-empty string`);
  }
  if (seenKeys.has(item.localItemKey)) {
    fail(`duplicate localItemKey: ${item.localItemKey}`);
  }
  seenKeys.add(item.localItemKey);

  if (!ITEM_KINDS.includes(item.kind)) {
    fail(`items[${index}].kind is invalid: ${String(item.kind)}`);
  }
  if (!isNonEmptyString(item.claim)) {
    fail(`items[${index}].claim must be a non-empty string`);
  }
  if (!SCOPES.has(item.scope)) {
    fail(`items[${index}].scope is invalid: ${String(item.scope)}`);
  }
  if (item.scope === 'conversation') {
    if (!isNonEmptyString(item.conversationId)) {
      fail(`items[${index}].conversationId is required for scope=conversation`);
    }
  } else if (item.scope === 'cross_conversation') {
    if (item.conversationId != null) {
      fail(`items[${index}].conversationId must be null for scope=cross_conversation`);
    }
  }

  if (!SENSITIVITIES.has(item.sensitivity)) {
    fail(`items[${index}].sensitivity is invalid: ${String(item.sensitivity)}`);
  }

  const allowedStatus = STATUS_BY_KIND[item.kind];
  if (!allowedStatus.has(item.status)) {
    fail(`items[${index}].status "${item.status}" is invalid for kind=${item.kind}`);
  }

  for (const field of ['eventTimeStart', 'eventTimeEnd']) {
    const v = item[field];
    if (v == null) continue;
    if (!isValidIsoDateOrDateTime(v)) {
      fail(`items[${index}].${field} must be ISO date or datetime`);
    }
  }
  if (item.eventTimeStart != null && item.eventTimeEnd != null) {
    const a = toSortableInstant(item.eventTimeStart);
    const b = toSortableInstant(item.eventTimeEnd);
    if (a > b) {
      fail(`items[${index}].eventTimeStart must not be later than eventTimeEnd`);
    }
  }

  if (item.kind === 'hypothesis') {
    if (!isNonEmptyString(item.alternative)) {
      fail(`items[${index}].alternative is required for hypothesis`);
    }
  } else if (item.alternative != null && item.alternative !== undefined) {
    // allow null or absent only
    if (item.alternative !== null) {
      fail(`items[${index}].alternative must be null for kind=${item.kind}`);
    }
  }
}

function validateEvidence(ev, index, itemByKey, caseData) {
  if (!isPlainObject(ev)) fail(`evidence[${index}] must be an object`);

  for (const field of [
    'itemKey',
    'sourceMessageId',
    'episodeKey',
    'relation',
    'provenanceRole',
    'mentionTime',
  ]) {
    if (!isNonEmptyString(ev[field])) {
      fail(`evidence[${index}].${field} must be a non-empty string`);
    }
  }

  if (!itemByKey.has(ev.itemKey)) {
    fail(`evidence[${index}].itemKey is unknown: ${ev.itemKey}`);
  }
  if (!EVIDENCE_RELATIONS.includes(ev.relation)) {
    fail(`evidence[${index}].relation is invalid: ${ev.relation}`);
  }
  if (!PROVENANCE_ROLES.has(ev.provenanceRole)) {
    fail(`evidence[${index}].provenanceRole is invalid: ${ev.provenanceRole}`);
  }
  if (!isValidIsoDateTime(ev.mentionTime)) {
    fail(`evidence[${index}].mentionTime must be a valid ISO datetime`);
  }

  const item = itemByKey.get(ev.itemKey);

  if (ev.relation === 'supports' && ev.provenanceRole !== 'user') {
    fail(
      `evidence[${index}]: ${ev.provenanceRole} cannot have relation=supports for ${item.kind}`,
    );
  }

  if (caseData) {
    const msg = caseData._messageById.get(ev.sourceMessageId);
    if (!msg) {
      fail(
        `evidence[${index}].sourceMessageId not found in caseData: ${ev.sourceMessageId}`,
      );
    }
    if (msg.role !== ev.provenanceRole) {
      fail(
        `evidence[${index}].provenanceRole "${ev.provenanceRole}" does not match message role "${msg.role}"`,
      );
    }
  }
}

function assertRecurrenceEvidence(item, evidenceForItem) {
  if (item.kind !== 'recurrence') return;
  if (item.status !== 'candidate' && item.status !== 'active') return;

  const userSupports = evidenceForItem.filter(
    (e) => e.relation === 'supports' && e.provenanceRole === 'user',
  );
  const episodeKeys = new Set(userSupports.map((e) => e.episodeKey));
  if (episodeKeys.size < 2) {
    fail(
      `recurrence "${item.localItemKey}" with status=${item.status} requires supports from at least two distinct user episodeKeys`,
    );
  }
}

/**
 * @param {unknown} value
 * @param {object} [caseData] optional validated or raw case; if raw, will be validated
 */
export function validateExtraction(value, caseData) {
  if (!isPlainObject(value)) fail('extraction must be an object');
  validateRun(value.run);

  if (!Array.isArray(value.items)) fail('extraction.items must be an array');
  if (!Array.isArray(value.evidence)) fail('extraction.evidence must be an array');

  let normalizedCase = null;
  if (caseData !== undefined && caseData !== null) {
    // Always validate; never trust a caller-supplied `_messageById` bypass marker.
    const validated = validateCase(caseData);
    if (value.run.caseId !== validated.caseId) {
      fail(
        `extraction.run.caseId "${value.run.caseId}" does not match caseData.caseId "${validated.caseId}"`,
      );
    }
    normalizedCase = enrichCase(validated);
  }

  const seenKeys = new Set();
  const itemByKey = new Map();
  value.items.forEach((item, index) => {
    validateItem(item, index, seenKeys);
    itemByKey.set(item.localItemKey, item);
  });

  const seenEvidence = new Set();
  value.evidence.forEach((ev, index) => {
    validateEvidence(ev, index, itemByKey, normalizedCase);
    const dupKey = `${ev.itemKey}\0${ev.sourceMessageId}\0${ev.relation}`;
    if (seenEvidence.has(dupKey)) {
      fail(
        `duplicate evidence for itemKey+sourceMessageId+relation: ${ev.itemKey}`,
      );
    }
    seenEvidence.add(dupKey);
  });

  for (const item of value.items) {
    const related = value.evidence.filter((e) => e.itemKey === item.localItemKey);
    assertRecurrenceEvidence(item, related);
  }

  return value;
}

function enrichCase(caseData) {
  const messageById = new Map();
  for (const m of caseData.messages) {
    messageById.set(m.id, m);
  }
  // Rebuild the lookup map after validation; ignore any caller-supplied `_messageById`.
  const rest = { ...caseData };
  delete rest._messageById;
  return { ...rest, _messageById: messageById };
}

export function validateCase(value) {
  if (!isPlainObject(value)) fail('case must be an object');
  if (!isNonEmptyString(value.caseId)) fail('case.caseId must be a non-empty string');
  if (!Array.isArray(value.messages)) fail('case.messages must be an array');

  const seenIds = new Set();
  const messageById = new Map();

  value.messages.forEach((msg, index) => {
    if (!isPlainObject(msg)) fail(`messages[${index}] must be an object`);
    if (!isNonEmptyString(msg.id)) fail(`messages[${index}].id must be a non-empty string`);
    if (seenIds.has(msg.id)) fail(`duplicate message id: ${msg.id}`);
    seenIds.add(msg.id);
    if (!PROVENANCE_ROLES.has(msg.role)) {
      fail(`messages[${index}].role is invalid: ${String(msg.role)}`);
    }
    if (typeof msg.text !== 'string') fail(`messages[${index}].text must be a string`);
    if (!isValidIsoDateTime(msg.createdAt)) {
      fail(`messages[${index}].createdAt must be a valid ISO datetime`);
    }
    messageById.set(msg.id, msg);
  });

  if (!isPlainObject(value.gold)) fail('case.gold is required and must be an object');
  for (const field of ['events', 'recurrences', 'hypotheses']) {
    if (!Array.isArray(value.gold[field])) {
      fail(`case.gold.${field} must be an array`);
    }
  }

  const checkGoldList = (list, label) => {
    list.forEach((entry, index) => {
      if (!isPlainObject(entry)) fail(`gold.${label}[${index}] must be an object`);
      for (const id of collectGoldMessageIds(entry)) {
        if (!messageById.has(id)) {
          fail(`gold.${label}[${index}] references missing message id: ${id}`);
        }
      }
    });
  };

  checkGoldList(value.gold.events, 'events');
  checkGoldList(value.gold.recurrences, 'recurrences');
  checkGoldList(value.gold.hypotheses, 'hypotheses');

  value.gold.recurrences.forEach((entry, index) => {
    const supportIds = Array.isArray(entry.supportMessageIds)
      ? entry.supportMessageIds
      : [];
    if (new Set(supportIds).size !== supportIds.length) {
      fail(`gold.recurrences[${index}] supportMessageIds must be unique`);
    }
    if (supportIds.length > 0) {
      const roles = supportIds.map((id) => messageById.get(id).role);
      const hasUser = roles.some((r) => r === 'user');
      const onlyNonUser = roles.every((r) => r === 'assistant' || r === 'system');
      if (!hasUser || onlyNonUser) {
        fail(
          `gold.recurrences[${index}] cannot be supported only by assistant/system messages`,
        );
      }
    }

    if (entry.episodeKeys !== undefined) {
      if (!Array.isArray(entry.episodeKeys)) {
        fail(`gold.recurrences[${index}].episodeKeys must be an array`);
      }
      if (entry.episodeKeys.length !== supportIds.length) {
        fail(
          `gold.recurrences[${index}]: episodeKeys length must match supportMessageIds length`,
        );
      }
      for (let i = 0; i < entry.episodeKeys.length; i++) {
        if (!isNonEmptyString(entry.episodeKeys[i])) {
          fail(
            `gold.recurrences[${index}].episodeKeys[${i}] must be a non-empty string`,
          );
        }
      }
      // Positional: supportMessageIds[i] ↔ episodeKeys[i]; only user roles count as episodes.
      const userEpisodeKeys = new Set();
      for (let i = 0; i < supportIds.length; i++) {
        const msg = messageById.get(supportIds[i]);
        if (msg.role === 'user') {
          userEpisodeKeys.add(entry.episodeKeys[i]);
        }
      }
      if (userEpisodeKeys.size < 2) {
        fail(
          `gold.recurrences[${index}] requires at least two distinct user episodeKeys corresponding to user support messages`,
        );
      }
    }
  });

  return value;
}
