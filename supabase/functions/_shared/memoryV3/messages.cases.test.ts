import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_V3_MAX_SOURCE_MESSAGES } from "./contract.ts";
import {
  MEMORY_V3_DELTA_CONTEXT_MESSAGES,
  MEMORY_V3_DELTA_MAX_MESSAGES,
  MEMORY_V3_DELTA_MAX_TOKENS,
  createMemoryV3MessageLoader,
  projectMemoryV3SourceRows,
} from "./messages.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const USER_MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const AI_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const ALPHA_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROWS = [
  { id: AI_MESSAGE_ID, sender: "ai", content: "Контекст", created_at: "2026-09-05T10:01:00.000Z" },
  { id: USER_MESSAGE_ID, sender: "user", content: "Первое сообщение", created_at: "2026-09-05T10:00:00.000Z" },
];

function cloneRows() { return ROWS.map((row) => ({ ...row })); }

function assertSafeError(error: unknown): boolean {
  assert(error instanceof Error);
  assert.equal(error.name, "MemoryV3MessagesError");
  assert.match(error.message, /^\[memory-v3:messages\]/);
  assert.equal("cause" in error, false);
  assert.equal(error.message.includes("RAW_DB_SECRET_SENTINEL"), false);
  assert.equal(JSON.stringify(error).includes("RAW_DB_SECRET_SENTINEL"), false);
  return true;
}

type FakeOptions = { owned?: boolean; ownershipError?: unknown; rows?: unknown; messagesError?: unknown; messagesResponse?: unknown };

function createFakeClient(options: FakeOptions = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const owned = options.owned ?? true;
  const rows = options.rows ?? cloneRows();
  function builder(table: string) {
    const chain = {
      select(columns: string) { calls.push({ method: "select", args: [table, columns] }); return chain; },
      eq(column: string, value: unknown) { calls.push({ method: "eq", args: [table, column, value] }); return chain; },
      order(column: string, config: unknown) { calls.push({ method: "order", args: [table, column, config] }); return chain; },
      limit(value: number) { calls.push({ method: "limit", args: [table, value] }); return Promise.resolve(options.messagesResponse ?? { data: rows, error: options.messagesError ?? null }); },
      maybeSingle() { calls.push({ method: "maybeSingle", args: [table] }); return Promise.resolve({ data: owned ? { id: CONVERSATION_ID } : null, error: options.ownershipError ?? null }); },
    };
    return chain;
  }
  return { calls, client: { from(table: string) { calls.push({ method: "from", args: [table] }); return builder(table); } } };
}

test("projectMemoryV3SourceRows copies, maps, and sorts source rows", () => {
  const rows = cloneRows();
  const snapshot = structuredClone(rows);
  const projected = projectMemoryV3SourceRows(rows);
  assert.deepEqual(projected, [
    { id: USER_MESSAGE_ID, role: "user", text: "Первое сообщение", createdAt: "2026-09-05T10:00:00.000Z" },
    { id: AI_MESSAGE_ID, role: "assistant", text: "Контекст", createdAt: "2026-09-05T10:01:00.000Z" },
  ]);
  assert.deepEqual(Object.keys(projected[0]), ["id", "role", "text", "createdAt"]);
  assert.deepEqual(rows, snapshot);
  assert.notEqual(projected[0], rows[1]);
});

test("projectMemoryV3SourceRows uses message id as deterministic tie-break", () => {
  const projected = projectMemoryV3SourceRows([{ ...ROWS[1], id: AI_MESSAGE_ID }, { ...ROWS[1], id: USER_MESSAGE_ID }]);
  assert.deepEqual(projected.map(({ id }) => id), [USER_MESSAGE_ID, AI_MESSAGE_ID]);
});

test("projectMemoryV3SourceRows orders timestamps by their actual UTC instant", () => {
  const projected = projectMemoryV3SourceRows([
    { ...ROWS[1], id: AI_MESSAGE_ID, created_at: "2026-09-05T10:00:00.000Z" },
    { ...ROWS[1], id: USER_MESSAGE_ID, created_at: "2026-09-05T11:00:00.000+02:00" },
  ]);
  assert.deepEqual(projected.map(({ id }) => id), [USER_MESSAGE_ID, AI_MESSAGE_ID]);
});

test("projectMemoryV3SourceRows rejects invalid arrays and rows", () => {
  const sparse = new Array(1);
  const extended = cloneRows();
  Object.defineProperty(extended, "extra", { value: true, enumerable: true });
  const tooMany = Array.from({ length: 61 }, (_, index) => ({ ...ROWS[1], id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
  const cases: unknown[] = [null, {}, [], sparse, extended, tooMany, [{ ...ROWS[1], extra: true }], [{ ...ROWS[1] }, { ...ROWS[1] }], [{ ...ROWS[1], id: "not-a-uuid" }], [{ ...ROWS[1], sender: "system" }], [{ ...ROWS[1], content: "" }], [{ ...ROWS[1], content: 1 }], [{ ...ROWS[1], created_at: "2026-02-30T10:00:00.000Z" }], [{ ...ROWS[0] }]];
  for (const value of cases) assert.throws(() => projectMemoryV3SourceRows(value), assertSafeError);
});

test("projectMemoryV3SourceRows rejects symbols, accessors, and non-enumerable fields", () => {
  let getterCalls = 0;
  const accessor = { ...ROWS[1] } as Record<string, unknown>;
  Object.defineProperty(accessor, "content", { enumerable: true, get() { getterCalls += 1; return "RAW_DB_SECRET_SENTINEL"; } });
  const symbol = { ...ROWS[1], [Symbol("RAW_DB_SECRET_SENTINEL")]: true };
  const hidden = { ...ROWS[1] };
  Object.defineProperty(hidden, "hidden", { value: true, enumerable: false });
  for (const value of [[accessor], [symbol], [hidden]]) assert.throws(() => projectMemoryV3SourceRows(value), assertSafeError);
  assert.equal(getterCalls, 0);
});

test("projectMemoryV3SourceRows safe-wraps revoked array and row Proxies", () => {
  const revokedArray = Proxy.revocable([], {});
  revokedArray.revoke();
  assert.throws(() => projectMemoryV3SourceRows(revokedArray.proxy), assertSafeError);

  const revokedRow = Proxy.revocable({ ...ROWS[1] }, {});
  revokedRow.revoke();
  assert.throws(() => projectMemoryV3SourceRows([revokedRow.proxy]), assertSafeError);
});

test("createMemoryV3MessageLoader verifies ownership before loading bounded messages", async () => {
  const fake = createFakeClient();
  const result = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID);
  assert.deepEqual(result.map(({ id }) => id), [USER_MESSAGE_ID, AI_MESSAGE_ID]);
  assert.deepEqual(fake.calls, [
    { method: "from", args: ["conversations"] },
    { method: "select", args: ["conversations", "id"] },
    { method: "eq", args: ["conversations", "id", CONVERSATION_ID] },
    { method: "eq", args: ["conversations", "user_id", USER_ID] },
    { method: "maybeSingle", args: ["conversations"] },
    { method: "from", args: ["messages"] },
    { method: "select", args: ["messages", "id, sender, content, created_at"] },
    { method: "eq", args: ["messages", "conversation_id", CONVERSATION_ID] },
    { method: "order", args: ["messages", "created_at", { ascending: false }] },
    { method: "order", args: ["messages", "id", { ascending: false }] },
    { method: "limit", args: ["messages", 60] },
  ]);
});

test("createMemoryV3MessageLoader fails before messages query when ownership is absent", async () => {
  const fake = createFakeClient({ owned: false });
  await assert.rejects(() => createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID), assertSafeError);
  assert.equal(fake.calls.some(({ args }) => args[0] === "messages"), false);
});

test("createMemoryV3MessageLoader rejects empty source and safe-wraps database errors", async () => {
  for (const options of [{ rows: [] }, { ownershipError: new Error("RAW_DB_SECRET_SENTINEL") }, { messagesError: { message: "RAW_DB_SECRET_SENTINEL" } }]) {
    const fake = createFakeClient(options);
    await assert.rejects(() => createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID), assertSafeError);
  }
});

test("createMemoryV3MessageLoader does not leak a thrown database exception", async () => {
  const client = {
    from() {
      throw new Error("RAW_DB_SECRET_SENTINEL");
    },
  };
  await assert.rejects(() => createMemoryV3MessageLoader(client)(USER_ID, CONVERSATION_ID), assertSafeError);
});

test("createMemoryV3MessageLoader does not execute response accessors", async () => {
  let getterCalls = 0;
  const response = { data: cloneRows(), error: null } as Record<string, unknown>;
  Object.defineProperty(response, "metadata", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "RAW_DB_SECRET_SENTINEL";
    },
  });
  const fake = createFakeClient({ messagesResponse: response });
  await assert.rejects(() => createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID), assertSafeError);
  assert.equal(getterCalls, 0);
});

test("createMemoryV3MessageLoader rejects invalid ids and clients before database access", async () => {
  for (const [userId, conversationId] of [["not-a-uuid", CONVERSATION_ID], [USER_ID, "not-a-uuid"], [ALPHA_USER_ID.toUpperCase(), CONVERSATION_ID]]) {
    const fake = createFakeClient();
    await assert.rejects(() => createMemoryV3MessageLoader(fake.client)(userId, conversationId), assertSafeError);
    assert.equal(fake.calls.length, 0);
  }
  assert.throws(() => createMemoryV3MessageLoader({ from: 1 } as never), assertSafeError);
});

test("createMemoryV3MessageLoader stops a cyclic Proxy prototype chain", () => {
  let prototypeCalls = 0;
  const client: object = new Proxy({}, {
    getOwnPropertyDescriptor() {
      return undefined;
    },
    getPrototypeOf() {
      prototypeCalls += 1;
      if (prototypeCalls > 2) throw new Error("RAW_DB_SECRET_SENTINEL");
      return client;
    },
  });

  assert.throws(() => createMemoryV3MessageLoader(client as never), assertSafeError);
  assert.equal(prototypeCalls, 1);
});

// ── Delta windowing (spec 2026-10-13 §1) ─────────────────────────────────────

const TOKEN_200_TEXT = "я".repeat(700); // estimateTokens -> exactly 200

type MessageRow = { id: string; sender: "user" | "ai"; content: string; created_at: string };

function timeline(index: number): string {
  return new Date(Date.UTC(2026, 8, 5, 10, 0, index)).toISOString();
}

function messageRow(index: number, content = TOKEN_200_TEXT, createdAt = timeline(index)): MessageRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    sender: index % 2 === 1 ? "user" : "ai",
    content,
    created_at: createdAt,
  };
}

function rowsBetween(first: number, last: number, content = TOKEN_200_TEXT): MessageRow[] {
  return Array.from({ length: last - first + 1 }, (_, offset) => messageRow(first + offset, content));
}

function cursorAt(row: MessageRow) {
  return { messageId: row.id, createdAt: row.created_at };
}

function idsOf(messages: Array<{ id: string }>): string[] {
  return messages.map(({ id }) => id);
}

const KEYSET_FILTER = /^created_at\.(gt|lt)\."([^"]+)",and\(created_at\.eq\."\2",id\.(gt|lte)\.([0-9a-f-]{36})\)$/;

type TableOptions = { deltaResponse?: unknown; latestResponse?: unknown };

// An in-memory messages table that actually evaluates the loader's keyset
// filter, ordering, and limit, so a test can walk a whole run sequence over
// one fixed conversation. deltaResponse / latestResponse override that one
// query's answer to simulate an inconsistent or failing database.
function createTableFakeClient(rows: MessageRow[], options: TableOptions = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  function builder(table: string) {
    let columns = "";
    let direction: "after" | "atOrBefore" | null = null;
    let keep: (row: MessageRow) => boolean = () => true;
    const orders: Array<{ column: string; ascending: boolean }> = [];
    const chain = {
      select(selected: string) { columns = selected; calls.push({ method: "select", args: [table, selected] }); return chain; },
      eq(column: string, value: unknown) { calls.push({ method: "eq", args: [table, column, value] }); return chain; },
      or(expression: string) {
        calls.push({ method: "or", args: [table, expression] });
        const match = KEYSET_FILTER.exec(expression);
        if (!match) throw new Error("unexpected or() filter");
        const [, timeOperator, createdAt, idOperator, id] = match;
        const at = Date.parse(createdAt);
        direction = timeOperator === "gt" ? "after" : "atOrBefore";
        keep = (row) => {
          const rowAt = Date.parse(row.created_at);
          if (rowAt !== at) return timeOperator === "gt" ? rowAt > at : rowAt < at;
          return idOperator === "gt" ? row.id > id : row.id <= id;
        };
        return chain;
      },
      order(column: string, config: { ascending: boolean }) {
        calls.push({ method: "order", args: [table, column, config] });
        orders.push({ column, ascending: config.ascending });
        return chain;
      },
      limit(value: number) {
        calls.push({ method: "limit", args: [table, value] });
        if (direction === "after" && options.deltaResponse !== undefined) return Promise.resolve(options.deltaResponse);
        if (direction === null && columns === "id" && options.latestResponse !== undefined) {
          return Promise.resolve(options.latestResponse);
        }
        const selected = rows.filter(keep).sort((left, right) => {
          for (const { column, ascending } of orders) {
            const compared = column === "created_at"
              ? Date.parse(left.created_at) - Date.parse(right.created_at)
              : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
            if (compared !== 0) return ascending ? compared : -compared;
          }
          return 0;
        });
        const data = selected.slice(0, value).map((row) => (columns === "id" ? { id: row.id } : { ...row }));
        return Promise.resolve({ data, error: null });
      },
      maybeSingle() {
        calls.push({ method: "maybeSingle", args: [table] });
        return Promise.resolve({ data: { id: CONVERSATION_ID }, error: null });
      },
    };
    return chain;
  }
  return { calls, client: { from(table: string) { calls.push({ method: "from", args: [table] }); return builder(table); } } };
}

test("delta constants keep context + delta inside the 60-message source cap", () => {
  assert.equal(MEMORY_V3_DELTA_CONTEXT_MESSAGES, 5);
  assert.equal(MEMORY_V3_DELTA_MAX_TOKENS, 4_000);
  assert.equal(MEMORY_V3_DELTA_MAX_MESSAGES + MEMORY_V3_DELTA_CONTEXT_MESSAGES, MEMORY_V3_MAX_SOURCE_MESSAGES);
});

test("createMemoryV3MessageLoader never token-caps a first run, even a long pre-rollout conversation", async () => {
  const rows = rowsBetween(1, 60); // 60 x 200 = 12000 estimated tokens
  const fake = createFakeClient({ rows });
  const result = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID);
  assert.equal(result.length, 60);
  assert.equal(fake.calls.at(-1)?.args[1], 60);
});

test("createMemoryV3MessageLoader loads the oldest messages after the cursor, the 5 ending at it, and the latest id", async () => {
  const rows = rowsBetween(1, 20, "Короткое сообщение");
  const fake = createTableFakeClient(rows);
  const cursor = cursorAt(rows[4]);
  const loaded = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursor);
  assert.deepEqual(idsOf(loaded.context), idsOf(rows.slice(0, 5)));
  assert.deepEqual(idsOf(loaded.delta), idsOf(rows.slice(5)));
  assert.equal(loaded.latestMessageId, rows[19].id);
  const after = `created_at.gt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.gt.${cursor.messageId})`;
  const atOrBefore = `created_at.lt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.lte.${cursor.messageId})`;
  assert.deepEqual(fake.calls.slice(5), [
    { method: "from", args: ["messages"] },
    { method: "select", args: ["messages", "id, sender, content, created_at"] },
    { method: "eq", args: ["messages", "conversation_id", CONVERSATION_ID] },
    { method: "or", args: ["messages", after] },
    { method: "order", args: ["messages", "created_at", { ascending: true }] },
    { method: "order", args: ["messages", "id", { ascending: true }] },
    { method: "limit", args: ["messages", 55] },
    { method: "from", args: ["messages"] },
    { method: "select", args: ["messages", "id, sender, content, created_at"] },
    { method: "eq", args: ["messages", "conversation_id", CONVERSATION_ID] },
    { method: "or", args: ["messages", atOrBefore] },
    { method: "order", args: ["messages", "created_at", { ascending: false }] },
    { method: "order", args: ["messages", "id", { ascending: false }] },
    { method: "limit", args: ["messages", 5] },
    { method: "from", args: ["messages"] },
    { method: "select", args: ["messages", "id"] },
    { method: "eq", args: ["messages", "conversation_id", CONVERSATION_ID] },
    { method: "order", args: ["messages", "created_at", { ascending: false }] },
    { method: "order", args: ["messages", "id", { ascending: false }] },
    { method: "limit", args: ["messages", 1] },
  ]);
});

test("createMemoryV3MessageLoader hands out the OLDEST 55 of a larger backlog, never the newest", async () => {
  const rows = rowsBetween(1, 100, "Короткое сообщение");
  const fake = createTableFakeClient(rows);
  const loaded = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(rows[4]));
  assert.deepEqual(idsOf(loaded.delta), idsOf(rows.slice(5, 60)));
  assert.equal(loaded.latestMessageId, rows[99].id);
});

test("createMemoryV3MessageLoader places same-timestamp messages on the right side of the cursor by id", async () => {
  // Messages 2, 3, and 4 share one created_at and the cursor is on 3. A
  // time-only comparison would put 4 at-or-before the cursor and skip it
  // forever; the compound (created_at, id) comparison must not.
  const shared = timeline(2);
  const rows = [
    messageRow(1, "Первое"),
    messageRow(2, "Второе", shared),
    messageRow(3, "Третье", shared),
    messageRow(4, "Четвёртое", shared),
    messageRow(5, "Пятое"),
  ];
  const fake = createTableFakeClient(rows);
  const loaded = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(rows[2]));
  assert.deepEqual(idsOf(loaded.context), idsOf(rows.slice(0, 3)));
  assert.deepEqual(idsOf(loaded.delta), idsOf(rows.slice(3)));
});

test("createMemoryV3MessageLoader returns an empty delta when nothing new arrived since the cursor", async () => {
  const rows = rowsBetween(1, 5, "Контекст");
  const fake = createTableFakeClient(rows);
  const loaded = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(rows[4]));
  assert.deepEqual(idsOf(loaded.context), idsOf(rows));
  assert.deepEqual(loaded.delta, []);
  assert.equal(loaded.latestMessageId, rows[4].id);
});

test("createMemoryV3MessageLoader meets the token target by trimming the NEWEST end of the chunk; the trimmed messages open the next window", async () => {
  const rows = rowsBetween(1, 25); // 200 estimated tokens each
  const fake = createTableFakeClient(rows);
  const load = createMemoryV3MessageLoader(fake.client);
  const first = await load(USER_ID, CONVERSATION_ID, cursorAt(rows[4]));
  // 5 context x 200 + 15 delta x 200 = 4000: messages 6-20 fit, 21-25 wait.
  assert.deepEqual(idsOf(first.context), idsOf(rows.slice(0, 5)));
  assert.deepEqual(idsOf(first.delta), idsOf(rows.slice(5, 20)));
  const next = await load(USER_ID, CONVERSATION_ID, cursorAt(rows[19]));
  assert.deepEqual(idsOf(next.delta), idsOf(rows.slice(20)));
});

test("createMemoryV3MessageLoader keeps the context block and the oldest undrained message even when they alone exceed the token target", async () => {
  for (const rows of [
    [...rowsBetween(1, 5), messageRow(6, "я".repeat(14_000)), messageRow(7)], // oldest delta message alone = 4000
    [...rowsBetween(1, 5, "я".repeat(3_500)), messageRow(6), messageRow(7)], // context alone = 5000
  ]) {
    const fake = createTableFakeClient(rows);
    const loaded = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(rows[4]));
    assert.deepEqual(idsOf(loaded.context), idsOf(rows.slice(0, 5)));
    assert.deepEqual(idsOf(loaded.delta), [rows[5].id]);
  }
});

test("createMemoryV3MessageLoader drains a 150-message backlog oldest-first: every message in exactly one window, no gap", async () => {
  const rows = rowsBetween(1, 155); // cursor on message 5, then 150 undrained
  const fake = createTableFakeClient(rows);
  const load = createMemoryV3MessageLoader(fake.client);
  const drained: string[] = [];
  let cursor = cursorAt(rows[4]);
  let loads = 0;
  for (;;) {
    const loaded = await load(USER_ID, CONVERSATION_ID, cursor);
    loads += 1;
    assert.equal(loads <= 50, true);
    if (loaded.delta.length === 0) break;
    drained.push(...idsOf(loaded.delta));
    // The next cursor is the last message THIS window actually carried.
    const last = loaded.delta[loaded.delta.length - 1];
    cursor = { messageId: last.id, createdAt: last.createdAt };
  }
  assert.deepEqual(drained, idsOf(rows.slice(5)));
  // 10 windows of 15 (the token target binds every time), then the empty one.
  assert.equal(loads, 11);
});

test("createMemoryV3MessageLoader rejects a malformed cursor, null included, before any database access", async () => {
  let getterCalls = 0;
  const accessor = { messageId: USER_MESSAGE_ID } as Record<string, unknown>;
  Object.defineProperty(accessor, "createdAt", {
    enumerable: true,
    get() { getterCalls += 1; return "2026-09-05T10:00:00.000Z"; },
  });
  for (const cursor of [
    null,
    { messageId: "not-a-uuid", createdAt: "2026-09-05T10:00:00.000Z" },
    { messageId: USER_MESSAGE_ID, createdAt: "yesterday" },
    { messageId: USER_MESSAGE_ID, createdAt: "2026-09-05T10:00:00.000Z", extra: "RAW_DB_SECRET_SENTINEL" },
    accessor,
  ]) {
    const fake = createTableFakeClient([]);
    await assert.rejects(
      () => createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursor as never),
      assertSafeError,
    );
    assert.equal(fake.calls.length, 0);
  }
  assert.equal(getterCalls, 0);
});

test("createMemoryV3MessageLoader rejects a delta that overlaps its context, arrives out of order, or errors, and a missing latest message", async () => {
  const rows = rowsBetween(1, 7);
  for (const options of [
    { deltaResponse: { data: [rows[4]], error: null } },
    { deltaResponse: { data: [rows[6], rows[5]], error: null } },
    { deltaResponse: { data: null, error: { message: "RAW_DB_SECRET_SENTINEL" } } },
    { latestResponse: { data: [], error: null } },
    { latestResponse: { data: null, error: { message: "RAW_DB_SECRET_SENTINEL" } } },
  ]) {
    const fake = createTableFakeClient(rows, options);
    await assert.rejects(
      () => createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(rows[4])),
      assertSafeError,
    );
  }
});
