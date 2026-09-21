import { isProxy } from 'node:util/types';

import {
  prepareLifecycleHistoryBackfill,
  type LifecycleHistoryConversationInput,
  type PreparedLifecycleHistoryBackfill,
} from './lifecycle-history-backfill-contract.ts';
import { LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID } from './lifecycle-history-backfill-profile.ts';

export interface LifecycleHistoryPageCursor {
  createdAt: string;
  id: string;
}

export interface LifecycleHistorySourceReader {
  listConversationsPage(input: {
    userId: string;
    sourceCutoff: string;
    after: LifecycleHistoryPageCursor | null;
    limit: 100;
  }): Promise<unknown>;
  listMessagesPage(input: {
    userId: string;
    conversationId: string;
    sourceCutoff: string;
    after: LifecycleHistoryPageCursor | null;
    limit: 100;
  }): Promise<unknown>;
}

export interface LifecycleHistorySupabaseClient {
  from(table: string): unknown;
}

interface ConversationSourceRow {
  id: string;
  userId: string;
  createdAt: string;
}

interface MessageSourceRow {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

const INSPECT_FIELDS = ['profileId', 'userId', 'sourceCutoff', 'reader'] as const;
const READER_FIELDS = ['listConversationsPage', 'listMessagesPage'] as const;
const CURSOR_FIELDS = ['createdAt', 'id'] as const;
const CONVERSATION_FIELDS = ['id', 'user_id', 'created_at'] as const;
const MESSAGE_FIELDS = ['id', 'conversation_id', 'sender', 'content', 'created_at'] as const;
const JOINED_MESSAGE_FIELDS = [...MESSAGE_FIELDS, 'conversations'] as const;
const OWNERSHIP_FIELDS = ['user_id'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
const PAGE_LIMIT = 100 as const;
const OWN_ERRORS = new WeakSet<object>();
const ERROR_TOKENS = new WeakMap<object, object>();

function makeError(token: object): Error {
  const error = new Error(
    '[memory-v3:lifecycle-history-backfill-source] source inspection failed',
  );
  error.name = 'MemoryV3LifecycleHistoryBackfillSourceError';
  OWN_ERRORS.add(error);
  ERROR_TOKENS.set(error, token);
  return error;
}

function fail(token: object): never {
  throw makeError(token);
}

function isOwnError(error: unknown, token: object): boolean {
  return typeof error === 'object' &&
    error !== null &&
    OWN_ERRORS.has(error) &&
    ERROR_TOKENS.get(error) === token;
}

function boundary<T>(operation: (token: object) => T): T {
  const token = Object.freeze({});
  try {
    return operation(token);
  } catch (error) {
    if (isOwnError(error, token)) throw error;
    throw makeError(token);
  }
}

async function asyncBoundary<T>(operation: (token: object) => Promise<T>): Promise<T> {
  const token = Object.freeze({});
  try {
    return await operation(token);
  } catch (error) {
    if (isOwnError(error, token)) throw error;
    throw makeError(token);
  }
}

function projectRecord(
  token: object,
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
    fail(token);
  }
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(token);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(token);
  if (keys.length !== fields.length) fail(token);
  const allowed = new Set(fields);
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) fail(token);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(token);
    }
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.value === undefined
    ) {
      fail(token);
    }
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(output, field)) fail(token);
  }
  return output;
}

function projectDensePage(token: object, value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null || isProxy(value) || !Array.isArray(value)) {
    fail(token);
  }
  let keys: PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail(token);
  }
  if (
    !lengthDescriptor ||
    !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > PAGE_LIMIT ||
    keys.length !== lengthDescriptor.value + 1
  ) {
    fail(token);
  }
  const length = lengthDescriptor.value as number;
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail(token);
    }
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.value === undefined
    ) {
      fail(token);
    }
    output.push(descriptor.value);
  }
  for (const key of keys) {
    if (key === 'length') continue;
    if (
      typeof key !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(key) ||
      Number(key) >= length
    ) {
      fail(token);
    }
  }
  return output;
}

function parseDateTimeNanoseconds(value: unknown): bigint | null {
  if (typeof value !== 'string' || value.trim() !== value) return null;
  const match = DATE_TIME.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? '0');
  if (hour > 23 || minute > 59 || second > 59 || month < 1 || month > 12) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return null;
  if (match[8] !== 'Z') {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return null;
    }
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = (match[7] ?? '').padEnd(9, '0');
  return BigInt(milliseconds) * 1_000_000n + BigInt(fraction.slice(3) || '0');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCursorValues(left: LifecycleHistoryPageCursor, right: LifecycleHistoryPageCursor): number {
  const leftTime = parseDateTimeNanoseconds(left.createdAt);
  const rightTime = parseDateTimeNanoseconds(right.createdAt);
  if (leftTime === null || rightTime === null) throw new Error('trusted cursor is invalid');
  return leftTime < rightTime
    ? -1
    : leftTime > rightTime
    ? 1
    : compareStrings(left.id, right.id);
}

function projectCursor(token: object, value: unknown): LifecycleHistoryPageCursor | null {
  if (value === null) return null;
  const row = projectRecord(token, value, CURSOR_FIELDS);
  if (
    typeof row.id !== 'string' ||
    !UUID.test(row.id) ||
    parseDateTimeNanoseconds(row.createdAt) === null
  ) {
    fail(token);
  }
  return { id: row.id, createdAt: row.createdAt as string };
}

function projectConversationRow(
  token: object,
  value: unknown,
  userId: string,
  sourceCutoffNanoseconds: bigint,
): ConversationSourceRow {
  const row = projectRecord(token, value, CONVERSATION_FIELDS);
  const createdAtNanoseconds = parseDateTimeNanoseconds(row.created_at);
  if (
    typeof row.id !== 'string' ||
    !UUID.test(row.id) ||
    row.user_id !== userId ||
    createdAtNanoseconds === null ||
    createdAtNanoseconds > sourceCutoffNanoseconds
  ) {
    fail(token);
  }
  return { id: row.id, userId, createdAt: row.created_at as string };
}

function projectMessageRow(
  token: object,
  value: unknown,
  conversationId: string,
  sourceCutoffNanoseconds: bigint,
): MessageSourceRow {
  const row = projectRecord(token, value, MESSAGE_FIELDS);
  const createdAtNanoseconds = parseDateTimeNanoseconds(row.created_at);
  if (
    typeof row.id !== 'string' ||
    !UUID.test(row.id) ||
    row.conversation_id !== conversationId ||
    (row.sender !== 'user' && row.sender !== 'ai') ||
    typeof row.content !== 'string' ||
    row.content.trim().length === 0 ||
    createdAtNanoseconds === null ||
    createdAtNanoseconds > sourceCutoffNanoseconds
  ) {
    fail(token);
  }
  return {
    id: row.id,
    conversationId,
    role: row.sender === 'user' ? 'user' : 'assistant',
    text: row.content,
    createdAt: row.created_at as string,
  };
}

function getMethod(token: object, target: unknown, name: string): (...args: unknown[]) => unknown {
  if (
    (typeof target !== 'object' && typeof target !== 'function') ||
    target === null ||
    isProxy(target)
  ) {
    fail(token);
  }
  try {
    let cursor: object | null = target as object;
    const seen = new Set<object>();
    while (cursor !== null) {
      if (isProxy(cursor)) fail(token);
      if (seen.has(cursor)) fail(token);
      seen.add(cursor);
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
      if (descriptor) {
        if (
          !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          typeof descriptor.value !== 'function'
        ) {
          fail(token);
        }
        return descriptor.value.bind(target);
      }
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch (error) {
    if (isOwnError(error, token)) throw error;
    fail(token);
  }
  fail(token);
}

function call(token: object, target: unknown, name: string, ...args: unknown[]): unknown {
  return getMethod(token, target, name)(...args);
}

function inspectResponse(token: object, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
    fail(token);
  }
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(token);
  }
  const allowed = new Set(['data', 'error', 'count', 'status', 'statusText']);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) fail(token);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(token);
    }
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      fail(token);
    }
  }
  const data = Object.getOwnPropertyDescriptor(value, 'data');
  const error = Object.getOwnPropertyDescriptor(value, 'error');
  if (
    !data ||
    !error ||
    data.enumerable !== true ||
    error.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(data, 'value') ||
    !Object.prototype.hasOwnProperty.call(error, 'value') ||
    error.value !== null
  ) {
    fail(token);
  }
  return data.value;
}

function inspectReader(token: object, value: unknown): LifecycleHistorySourceReader {
  const record = projectRecord(token, value, READER_FIELDS);
  if (
    typeof record.listConversationsPage !== 'function' ||
    typeof record.listMessagesPage !== 'function'
  ) {
    fail(token);
  }
  return {
    listConversationsPage: record.listConversationsPage.bind(value) as LifecycleHistorySourceReader['listConversationsPage'],
    listMessagesPage: record.listMessagesPage.bind(value) as LifecycleHistorySourceReader['listMessagesPage'],
  };
}

async function collectConversationPages(
  token: object,
  reader: LifecycleHistorySourceReader,
  userId: string,
  sourceCutoff: string,
): Promise<ConversationSourceRow[]> {
  const cutoff = parseDateTimeNanoseconds(sourceCutoff);
  if (cutoff === null) fail(token);
  const result: ConversationSourceRow[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let after: LifecycleHistoryPageCursor | null = null;
  while (true) {
    const raw = await reader.listConversationsPage({
      userId,
      sourceCutoff,
      after: after === null ? null : { ...after },
      limit: PAGE_LIMIT,
    });
    const page = projectDensePage(token, raw).map((row) =>
      projectConversationRow(token, row, userId, cutoff)
    );
    page.sort((left, right) => compareCursorValues(left, right));
    for (const row of page) {
      if (ids.has(row.id)) fail(token);
      if (after !== null && compareCursorValues(row, after) <= 0) fail(token);
      ids.add(row.id);
      result.push(row);
    }
    if (page.length < PAGE_LIMIT) return result;
    const last = page[page.length - 1];
    const next = { createdAt: last.createdAt, id: last.id };
    const key = `${next.createdAt}\u0000${next.id}`;
    if (cursors.has(key) || (after !== null && compareCursorValues(next, after) <= 0)) fail(token);
    cursors.add(key);
    after = next;
  }
}

async function collectMessagePages(
  token: object,
  reader: LifecycleHistorySourceReader,
  userId: string,
  conversationId: string,
  sourceCutoff: string,
  globalMessageIds: Set<string>,
): Promise<MessageSourceRow[]> {
  const cutoff = parseDateTimeNanoseconds(sourceCutoff);
  if (cutoff === null) fail(token);
  const result: MessageSourceRow[] = [];
  const cursors = new Set<string>();
  let after: LifecycleHistoryPageCursor | null = null;
  while (true) {
    const raw = await reader.listMessagesPage({
      userId,
      conversationId,
      sourceCutoff,
      after: after === null ? null : { ...after },
      limit: PAGE_LIMIT,
    });
    const page = projectDensePage(token, raw).map((row) =>
      projectMessageRow(token, row, conversationId, cutoff)
    );
    page.sort((left, right) => compareCursorValues(left, right));
    for (const row of page) {
      if (globalMessageIds.has(row.id)) fail(token);
      if (after !== null && compareCursorValues(row, after) <= 0) fail(token);
      globalMessageIds.add(row.id);
      result.push(row);
    }
    if (page.length < PAGE_LIMIT) return result;
    const last = page[page.length - 1];
    const next = { createdAt: last.createdAt, id: last.id };
    const key = `${next.createdAt}\u0000${next.id}`;
    if (cursors.has(key) || (after !== null && compareCursorValues(next, after) <= 0)) fail(token);
    cursors.add(key);
    after = next;
  }
}

function compositeKeysetFilter(after: LifecycleHistoryPageCursor): string {
  return `created_at.gt.${after.createdAt},and(created_at.eq.${after.createdAt},id.gt.${after.id})`;
}

function validatePageInput(token: object, input: unknown, withConversation: boolean): {
  userId: string;
  conversationId?: string;
  sourceCutoff: string;
  after: LifecycleHistoryPageCursor | null;
  limit: 100;
} {
  const fields = withConversation
    ? ['userId', 'conversationId', 'sourceCutoff', 'after', 'limit']
    : ['userId', 'sourceCutoff', 'after', 'limit'];
  const row = projectRecord(token, input, fields);
  const after = projectCursor(token, row.after);
  if (
    typeof row.userId !== 'string' ||
    !UUID.test(row.userId) ||
    (withConversation && (typeof row.conversationId !== 'string' || !UUID.test(row.conversationId))) ||
    parseDateTimeNanoseconds(row.sourceCutoff) === null ||
    row.limit !== PAGE_LIMIT
  ) {
    fail(token);
  }
  return {
    userId: row.userId,
    ...(withConversation ? { conversationId: row.conversationId as string } : {}),
    sourceCutoff: row.sourceCutoff as string,
    after,
    limit: PAGE_LIMIT,
  };
}

export function createLifecycleHistorySupabaseReader(
  client: unknown,
): LifecycleHistorySourceReader {
  return boundary((creationToken) => {
    getMethod(creationToken, client, 'from');
    return {
      listConversationsPage(input) {
        return asyncBoundary(async (token) => {
          const page = validatePageInput(token, input, false);
          let query = call(token, client, 'from', 'conversations');
          query = call(token, query, 'select', 'id, user_id, created_at');
          query = call(token, query, 'eq', 'user_id', page.userId);
          query = call(token, query, 'lte', 'created_at', page.sourceCutoff);
          query = call(token, query, 'order', 'created_at', { ascending: true });
          query = call(token, query, 'order', 'id', { ascending: true });
          if (page.after !== null) {
            query = call(token, query, 'or', compositeKeysetFilter(page.after));
          }
          const data = inspectResponse(token, await call(token, query, 'limit', PAGE_LIMIT));
          return projectDensePage(token, data).map((value) => {
            const row = projectRecord(token, value, CONVERSATION_FIELDS);
            if (row.user_id !== page.userId) fail(token);
            return {
              id: row.id,
              user_id: row.user_id,
              created_at: row.created_at,
            };
          });
        });
      },
      listMessagesPage(input) {
        return asyncBoundary(async (token) => {
          const page = validatePageInput(token, input, true);
          let query = call(token, client, 'from', 'messages');
          query = call(
            token,
            query,
            'select',
            'id, conversation_id, sender, content, created_at, conversations!inner(user_id)',
          );
          query = call(token, query, 'eq', 'conversation_id', page.conversationId);
          query = call(token, query, 'eq', 'conversations.user_id', page.userId);
          query = call(token, query, 'lte', 'created_at', page.sourceCutoff);
          query = call(token, query, 'order', 'created_at', { ascending: true });
          query = call(token, query, 'order', 'id', { ascending: true });
          if (page.after !== null) {
            query = call(token, query, 'or', compositeKeysetFilter(page.after));
          }
          const data = inspectResponse(token, await call(token, query, 'limit', PAGE_LIMIT));
          return projectDensePage(token, data).map((value) => {
            const row = projectRecord(token, value, JOINED_MESSAGE_FIELDS);
            const owner = projectRecord(token, row.conversations, OWNERSHIP_FIELDS);
            if (owner.user_id !== page.userId || row.conversation_id !== page.conversationId) {
              fail(token);
            }
            return {
              id: row.id,
              conversation_id: row.conversation_id,
              sender: row.sender,
              content: row.content,
              created_at: row.created_at,
            };
          });
        });
      },
    };
  });
}

export async function inspectLifecycleHistorySource(input: {
  profileId: unknown;
  userId: unknown;
  sourceCutoff: unknown;
  reader: unknown;
}): Promise<PreparedLifecycleHistoryBackfill> {
  return asyncBoundary(async (token) => {
    const root = projectRecord(token, input, INSPECT_FIELDS);
    if (
      root.profileId !== LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID ||
      typeof root.userId !== 'string' ||
      !UUID.test(root.userId) ||
      parseDateTimeNanoseconds(root.sourceCutoff) === null
    ) {
      fail(token);
    }
    const profileId = root.profileId;
    const userId = root.userId;
    const sourceCutoff = root.sourceCutoff as string;
    const reader = inspectReader(token, root.reader);
    const conversations = await collectConversationPages(token, reader, userId, sourceCutoff);
    const globalMessageIds = new Set<string>();
    const withMessages: LifecycleHistoryConversationInput[] = [];
    for (const conversation of conversations) {
      const messages = await collectMessagePages(
        token,
        reader,
        userId,
        conversation.id,
        sourceCutoff,
        globalMessageIds,
      );
      withMessages.push({
        conversationId: conversation.id,
        createdAt: conversation.createdAt,
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
      });
    }
    return prepareLifecycleHistoryBackfill({
      profileId,
      snapshot: { userId, sourceCutoff, conversations: withMessages },
    });
  });
}
