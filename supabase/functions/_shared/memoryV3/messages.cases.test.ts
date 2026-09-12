import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryV3MessageLoader, projectMemoryV3SourceRows } from "./messages.ts";

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
    { method: "order", args: ["messages", "created_at", { ascending: true }] },
    { method: "order", args: ["messages", "id", { ascending: true }] },
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
  let client: object;
  client = new Proxy({}, {
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
