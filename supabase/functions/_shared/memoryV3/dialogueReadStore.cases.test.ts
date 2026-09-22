import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  MEMORY_V3_DIALOGUE_READ_MAX_ITEMS,
  MEMORY_V3_DIALOGUE_READ_SCHEMA_VERSION,
  createMemoryV3DialogueReadStore,
  projectMemoryV3DialogueReadContext,
} from "./dialogueReadStore.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ALPHA_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const ALPHA_CONVERSATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SCHEMA_VERSION = "memory-v3-dialogue-read-context-v1";
const MIGRATION_URL = new URL(
  "../../../migrations/20260922130000_039_memory_v3_dialogue_isolation.sql",
  import.meta.url,
);

function validContext() {
  return {
    schemaVersion: SCHEMA_VERSION,
    stateRevision: 7,
    items: [
      {
        kind: "event",
        claim: "Пользователь вернулся к работе после отпуска.",
        status: "active",
        sensitivity: "normal",
        eventTimeStart: "2026-09-01",
        eventTimeEnd: null,
        alternative: null,
        updatedAt: "2026-09-20T08:00:00Z",
      },
      {
        kind: "recurrence",
        claim: "При неопределённости заранее перепроверяет планы.",
        status: "active",
        sensitivity: "sensitive",
        eventTimeStart: null,
        eventTimeEnd: null,
        alternative: null,
        updatedAt: "2026-09-19T08:00:00+03:00",
      },
      {
        kind: "hypothesis",
        claim: "Юмор помогает дозировать уязвимость.",
        status: "supported",
        sensitivity: "normal",
        eventTimeStart: null,
        eventTimeEnd: null,
        alternative: "Юмор помогает поддержать окружающих.",
        updatedAt: "2026-09-18T08:00:00.123Z",
      },
    ],
  };
}

function assertSafeStoreError(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.name, "MemoryV3DialogueReadStoreError");
    assert.equal(error.message, "[memory-v3:dialogue-read-store] operation failed");
    assert.equal("cause" in error, false);
    assert.equal(error.message.includes("SENTINEL"), false);
    assert.equal(JSON.stringify(error).includes("SENTINEL"), false);
    return true;
  });
}

async function assertSafeStoreRejection(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.name, "MemoryV3DialogueReadStoreError");
    assert.equal(error.message, "[memory-v3:dialogue-read-store] operation failed");
    assert.equal("cause" in error, false);
    assert.equal(error.message.includes("SENTINEL"), false);
    assert.equal(JSON.stringify(error).includes("SENTINEL"), false);
    return true;
  });
}

class QueryLike<T> implements PromiseLike<T> {
  constructor(private readonly value: T) {}

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.value).then(
      onfulfilled ?? undefined,
      onrejected ?? undefined,
    );
  }
}

describe("Memory V3 dialogue read projection", () => {
  test("exports the exact schema version and item cap", () => {
    assert.equal(MEMORY_V3_DIALOGUE_READ_SCHEMA_VERSION, SCHEMA_VERSION);
    assert.equal(MEMORY_V3_DIALOGUE_READ_MAX_ITEMS, 12);
  });

  test("projects a valid mixed context into fresh closed objects", () => {
    const input = validContext();
    const snapshot = structuredClone(input);
    const result = projectMemoryV3DialogueReadContext(input);

    assert.deepEqual(result, snapshot);
    assert.notEqual(result, input);
    assert.notEqual(result.items, input.items);
    for (let index = 0; index < result.items.length; index += 1) {
      assert.notEqual(result.items[index], input.items[index]);
      assert.deepEqual(Object.keys(result.items[index]), [
        "kind",
        "claim",
        "status",
        "sensitivity",
        "eventTimeStart",
        "eventTimeEnd",
        "alternative",
        "updatedAt",
      ]);
    }
    assert.deepEqual(input, snapshot);

    result.items[0].claim = "changed copy";
    assert.equal(input.items[0].claim, snapshot.items[0].claim);
  });

  test("accepts an authoritative empty item array", () => {
    assert.deepEqual(projectMemoryV3DialogueReadContext({
      schemaVersion: SCHEMA_VERSION,
      stateRevision: 0,
      items: [],
    }), {
      schemaVersion: SCHEMA_VERSION,
      stateRevision: 0,
      items: [],
    });
  });

  test("rejects every non-current kind and status combination", () => {
    const invalidPairs = [
      ["event", "corrected"],
      ["event", "rejected"],
      ["event", "supported"],
      ["recurrence", "candidate"],
      ["recurrence", "stale"],
      ["recurrence", "rejected"],
      ["recurrence", "supported"],
      ["hypothesis", "candidate"],
      ["hypothesis", "active"],
      ["hypothesis", "stale"],
      ["hypothesis", "rejected"],
      ["state", "active"],
    ];

    for (const [kind, status] of invalidPairs) {
      const input = validContext();
      input.items = [{
        ...input.items[0],
        kind,
        status,
        alternative: kind === "hypothesis" ? "Альтернатива" : null,
      }];
      assertSafeStoreError(() => projectMemoryV3DialogueReadContext(input));
    }
  });

  test("enforces alternative, sensitivity, dates, revision, and item cap", () => {
    const invalid = [
      { ...validContext(), schemaVersion: "v2" },
      { ...validContext(), stateRevision: -1 },
      { ...validContext(), stateRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...validContext(), stateRevision: 1.5 },
      { ...validContext(), items: Array.from({ length: 13 }, () => validContext().items[0]) },
      { ...validContext(), items: [{ ...validContext().items[0], sensitivity: "private" }] },
      { ...validContext(), items: [{ ...validContext().items[0], alternative: "not allowed" }] },
      { ...validContext(), items: [{ ...validContext().items[2], alternative: null }] },
      { ...validContext(), items: [{ ...validContext().items[2], alternative: "" }] },
      { ...validContext(), items: [{ ...validContext().items[0], eventTimeStart: "2023-02-29" }] },
      { ...validContext(), items: [{ ...validContext().items[0], eventTimeStart: "2026-10-02", eventTimeEnd: "2026-10-01" }] },
      { ...validContext(), items: [{ ...validContext().items[0], updatedAt: "not-a-date" }] },
      { ...validContext(), items: [{ ...validContext().items[0], claim: " padded " }] },
    ];

    for (const value of invalid) {
      assertSafeStoreError(() => projectMemoryV3DialogueReadContext(value));
    }
  });

  test("rejects unknown, symbol, non-enumerable, accessor, inherited and sparse values", () => {
    const unknown = { ...validContext(), rawProviderBody: "SENTINEL" };
    const symbol = validContext() as ReturnType<typeof validContext> & Record<symbol, unknown>;
    symbol[Symbol("SENTINEL")] = true;
    const nonEnumerable = validContext();
    Object.defineProperty(nonEnumerable, "stateRevision", { value: 7, enumerable: false });
    let getterCalls = 0;
    const accessor = validContext();
    Object.defineProperty(accessor, "items", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    const inherited = Object.create(validContext());
    const sparse = validContext();
    sparse.items = new Array(1) as ReturnType<typeof validContext>["items"];

    for (const value of [unknown, symbol, nonEnumerable, accessor, inherited, sparse]) {
      assertSafeStoreError(() => projectMemoryV3DialogueReadContext(value));
    }
    assert.equal(getterCalls, 0);
  });

  test("safe-wraps cyclic, revoked, throwing, and stateful proxy values", () => {
    const cyclic = validContext() as ReturnType<typeof validContext> & { self?: unknown };
    cyclic.self = cyclic;
    const { proxy: revoked, revoke } = Proxy.revocable(validContext(), {});
    revoke();
    const throwing = new Proxy(validContext(), {
      ownKeys() {
        throw new Error("RAW_SENTINEL");
      },
    });
    let descriptorCalls = 0;
    const stateful = new Proxy(validContext(), {
      getOwnPropertyDescriptor(target, key) {
        descriptorCalls += 1;
        if (descriptorCalls > 1) throw new Error("DESCRIPTOR_SENTINEL");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    for (const value of [cyclic, revoked, throwing, stateful]) {
      assertSafeStoreError(() => projectMemoryV3DialogueReadContext(value));
    }
  });
});

describe("Memory V3 dialogue read store", () => {
  test("calls one exact RPC with both userId and conversationId through prototype methods and a PromiseLike result", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    class Client {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return new QueryLike({ data: validContext(), error: null });
      }
    }

    const result = await createMemoryV3DialogueReadStore(new Client()).load(USER_ID, CONVERSATION_ID);
    assert.deepEqual(calls, [{
      name: "load_memory_v3_dialogue_read_context",
      args: { p_user_id: USER_ID, p_conversation_id: CONVERSATION_ID },
    }]);
    assert.deepEqual(result, validContext());
    assert.notEqual(result, calls);
  });

  test("returns null without a dialogue head and preserves an authoritative empty context", async () => {
    const nullStore = createMemoryV3DialogueReadStore({
      rpc() {
        return Promise.resolve({ data: null, error: null });
      },
    });
    const emptyStore = createMemoryV3DialogueReadStore({
      rpc() {
        return Promise.resolve({
          data: { schemaVersion: SCHEMA_VERSION, stateRevision: 3, items: [] },
          error: null,
        });
      },
    });

    assert.equal(await nullStore.load(USER_ID, CONVERSATION_ID), null);
    assert.deepEqual(await emptyStore.load(USER_ID, CONVERSATION_ID), {
      schemaVersion: SCHEMA_VERSION,
      stateRevision: 3,
      items: [],
    });
  });

  test("rejects invalid user or conversation ids before RPC", async () => {
    let calls = 0;
    const store = createMemoryV3DialogueReadStore({
      rpc() {
        calls += 1;
        return Promise.resolve({ data: null, error: null });
      },
    });

    for (const userId of ["", ALPHA_USER_ID.toUpperCase(), ` ${USER_ID}`, "*"]) {
      await assertSafeStoreRejection(() => store.load(userId, CONVERSATION_ID));
    }
    for (const conversationId of ["", ALPHA_CONVERSATION_ID.toUpperCase(), ` ${CONVERSATION_ID}`, "*"]) {
      await assertSafeStoreRejection(() => store.load(USER_ID, conversationId));
    }
    assert.equal(calls, 0);
  });

  test("rejects client accessors and never executes their getters", () => {
    let getterCalls = 0;
    const client = {
      get rpc() {
        getterCalls += 1;
        return () => Promise.resolve({ data: null, error: null });
      },
    };
    assertSafeStoreError(() => createMemoryV3DialogueReadStore(client));
    assert.equal(getterCalls, 0);
  });

  test("hides database errors, thrown sentinels, and hostile response accessors", async () => {
    const stores = [
      createMemoryV3DialogueReadStore({
        rpc() {
          return Promise.resolve({ data: null, error: { message: "DB_SENTINEL" } });
        },
      }),
      createMemoryV3DialogueReadStore({
        rpc() {
          throw new Error("THROWN_SENTINEL");
        },
      }),
      createMemoryV3DialogueReadStore({
        rpc() {
          const response = { data: null } as { data: null; error?: unknown };
          Object.defineProperty(response, "error", {
            enumerable: true,
            get() {
              throw new Error("GETTER_SENTINEL");
            },
          });
          return Promise.resolve(response as { data: unknown; error: unknown });
        },
      }),
    ];

    for (const store of stores) {
      await assertSafeStoreRejection(() => store.load(USER_ID, CONVERSATION_ID));
    }
  });

  test("does not mutate or alias the RPC result", async () => {
    const data = validContext();
    const snapshot = structuredClone(data);
    const store = createMemoryV3DialogueReadStore({
      rpc() {
        return Promise.resolve({ data, error: null, provider: "ignored" });
      },
    });

    const result = await store.load(USER_ID, CONVERSATION_ID);
    assert.deepEqual(data, snapshot);
    assert(result);
    assert.notEqual(result, data);
    assert.notEqual(result.items, data.items);
  });
});

describe("Memory V3 dialogue read migration", () => {
  test("creates one service-only empty-search-path read RPC, keyed by user and conversation", () => {
    const sql = readFileSync(MIGRATION_URL, "utf8");
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.load_memory_v3_dialogue_read_context\(\s*p_user_id uuid, p_conversation_id uuid\s*\)/);
    assert.match(sql, /RETURNS jsonb/);
    assert.match(sql, /SECURITY DEFINER/);
    assert.match(sql, /SET search_path = ''/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.load_memory_v3_dialogue_read_context\(uuid, uuid\) FROM PUBLIC, anon, authenticated/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.load_memory_v3_dialogue_read_context\(uuid, uuid\) TO service_role/);
    assert.doesNotMatch(
      sql,
      /pg_catalog\.coalesce/i,
      "COALESCE is PostgreSQL special syntax and must not be schema-qualified",
    );
    assert.match(sql, /COALESCE\(projected\.items, '\[\]'::jsonb\)/i);
  });

  test("projects only the current bounded dialogue context in deterministic order, scoped to one conversation", () => {
    const sql = readFileSync(MIGRATION_URL, "utf8");
    const readStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_read_context");
    const readEnd = sql.indexOf("CREATE OR REPLACE FUNCTION public.purge_memory_v3_dialogue_runs", readStart);
    const read = sql.slice(readStart, readEnd);
    assert.match(read, /public\.memory_v3_dialogue_heads/);
    assert.match(read, /public\.memory_v3_dialogue_items/);
    assert.match(read, /i\.kind = 'event' AND i\.status = 'active'/);
    assert.match(read, /i\.kind = 'recurrence' AND i\.status = 'active'/);
    assert.match(read, /i\.kind = 'hypothesis' AND i\.status = 'supported'/);
    assert.match(read, /ORDER BY i\.updated_at DESC, i\.memory_key COLLATE "C"/);
    assert.match(read, /LIMIT 12/);
    assert.match(read, /h\.user_id = p_user_id AND h\.conversation_id = p_conversation_id/);
    assert.match(read, /i\.user_id = p_user_id AND i\.conversation_id = p_conversation_id/);
    for (const key of [
      "schemaVersion",
      "stateRevision",
      "items",
      "kind",
      "claim",
      "status",
      "sensitivity",
      "eventTimeStart",
      "eventTimeEnd",
      "alternative",
      "updatedAt",
    ]) {
      assert.match(read, new RegExp(`'${key}'`));
    }
    // Unlike the lifecycle-shadow original (which forbids conversation_id
    // entirely, since that RPC is deliberately not conversation-scoped),
    // this function legitimately filters by it -- what stays forbidden is
    // reading anything from the evidence/runs/identities tables or their
    // audit-only columns.
    for (const forbidden of [
      "memory_v3_dialogue_evidence",
      "memory_v3_dialogue_runs",
      "memory_v3_dialogue_identities",
      "source_message_id",
      "provider",
      "prompt_tokens",
      "completion_tokens",
      "cost_usd",
    ]) {
      assert.equal(read.includes(forbidden), false, forbidden);
    }
  });
});
