import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { MemoryV3Extraction } from "./contract.ts";
import {
  createMemoryV3ShadowStore,
  type MemoryV3StoredDiagnostic,
} from "./shadowStore.ts";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MESSAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INPUT_HASH = "e".repeat(64);
const ITEM_KEY = "f".repeat(64);
const RAW_SECRET = "RAW_DATABASE_SECRET_SENTINEL";

const DIAGNOSTICS: MemoryV3StoredDiagnostic[] = [
  "invalid_source",
  "prompt_too_large",
  "reservation_failed",
  "transport_failed",
  "transport_timeout",
  "provider_http_4xx",
  "provider_http_5xx",
  "provider_response_invalid",
  "extractor_parse_invalid",
  "extractor_shape_invalid",
  "extractor_contract_invalid",
  "completion_write_failed",
  "unknown_failure",
];

function reservationInput() {
  return {
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    extractorVersion: "memory-v3-openrouter-gemini-3.7-flash-shadow-v2",
    model: "google/gemini-3.7-flash",
    inputHash: INPUT_HASH,
    sourceLastMessageId: MESSAGE_ID,
    sourceLastCreatedAt: "2026-09-05T10:00:00.000Z",
    messageCount: 2,
    userMessageCount: 1,
  };
}

function extraction(): MemoryV3Extraction {
  return {
    run: {
      caseId: `memory-v3-shadow:${USER_ID}:${CONVERSATION_ID}`,
      extractorVersion: "memory-v3-openrouter-gemini-3.7-flash-shadow-v2",
    },
    items: [{
      localItemKey: ITEM_KEY,
      kind: "event",
      claim: "Синтетический факт",
      scope: "cross_conversation",
      conversationId: null,
      eventTimeStart: "2026-09-05",
      eventTimeEnd: "2026-09-05",
      status: "active",
      sensitivity: "normal",
      alternative: null,
    }],
    evidence: [{
      itemKey: ITEM_KEY,
      sourceMessageId: MESSAGE_ID,
      relation: "supports",
      supportType: null,
      episodeKey: "episode:m1",
      provenanceRole: "user",
      mentionTime: "2026-09-05T10:00:00.000Z",
    }],
  };
}

function fakeClient(responses: Array<{ data: unknown; error: unknown } | Error>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        const response = responses.shift();
        if (response instanceof Error) throw response;
        assert.ok(response, "fake response is required");
        return response;
      },
    },
  };
}

async function captureStoreError(action: () => Promise<unknown>) {
  let caught: unknown;
  try { await action(); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /^\[memory-v3:shadow-store\] operation failed$/);
  assert.equal(caught.message.includes(RAW_SECRET), false);
  assert.equal(JSON.stringify(caught).includes(RAW_SECRET), false);
  assert.equal("cause" in caught, false);
  return caught;
}

describe("Memory V3 shadow migration", () => {
  const migrationUrl = new URL("../../../migrations/20260905120000_032_memory_v3_shadow_pilot.sql", import.meta.url);

  it("creates the durable identity ledger and protected 30-day run store", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    assert.match(sql, /CREATE TABLE public\.memory_v3_shadow_identities/i);
    assert.match(sql, /CREATE TABLE public\.memory_v3_shadow_runs/i);
    assert.match(sql, /PRIMARY KEY \(user_id, conversation_id, extractor_version, input_hash\)/i);
    assert.match(sql, /FOREIGN KEY \(user_id, conversation_id, extractor_version, input_hash\)[\s\S]*REFERENCES public\.memory_v3_shadow_identities/i);
    assert.match(sql, /REFERENCES public\.profiles\(id\) ON DELETE CASCADE/i);
    assert.match(sql, /REFERENCES public\.conversations\(id\) ON DELETE CASCADE/i);
    assert.match(sql, /input_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
    assert.match(sql, /message_count <= 60/i);
    assert.match(sql, /user_message_count <= message_count/i);
    assert.match(sql, /INTERVAL '30 days'/i);
  });

  it("locks terminal row shapes and the complete diagnostic allowlist", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    for (const diagnostic of DIAGNOSTICS) assert.ok(sql.includes(`'${diagnostic}'`), diagnostic);
    assert.match(sql, /status IN \('reserved', 'succeeded', 'failed'\)/i);
    assert.match(sql, /status = 'reserved'[\s\S]*completed_at IS NULL[\s\S]*extraction IS NULL/i);
    assert.match(sql, /status = 'succeeded'[\s\S]*completed_at IS NOT NULL[\s\S]*extraction IS NOT NULL[\s\S]*diagnostic_code IS NULL/i);
    assert.match(sql, /status = 'failed'[\s\S]*completed_at IS NOT NULL[\s\S]*diagnostic_code IS NOT NULL[\s\S]*extraction IS NULL/i);
    assert.match(sql, /prompt_tokens IS NULL[\s\S]*completion_tokens IS NULL[\s\S]*cost_usd IS NULL[\s\S]*OR[\s\S]*prompt_tokens IS NOT NULL[\s\S]*completion_tokens IS NOT NULL[\s\S]*cost_usd IS NOT NULL/i);
  });

  it("keeps reservation decisions atomic and in the reviewed order", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    const reserve = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.reserve_memory_v3_shadow_run"), sql.indexOf("CREATE OR REPLACE FUNCTION public.complete_memory_v3_shadow_run"));
    const offsets = [
      reserve.indexOf("FROM public.conversations"),
      reserve.indexOf("pg_catalog.pg_advisory_xact_lock"),
      reserve.indexOf("DELETE FROM public.memory_v3_shadow_runs"),
      reserve.indexOf("FROM public.memory_v3_shadow_identities"),
      reserve.indexOf("pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"),
      reserve.indexOf("IF v_daily_count >= 4"),
      reserve.indexOf("INSERT INTO public.memory_v3_shadow_identities"),
      reserve.indexOf("INSERT INTO public.memory_v3_shadow_runs"),
    ];
    assert.equal(offsets.every((offset) => offset >= 0), true, String(offsets));
    assert.deepEqual([...offsets].sort((a, b) => a - b), offsets);
    assert.match(reserve, /ON CONFLICT \(user_id, conversation_id, extractor_version, input_hash\) DO NOTHING/i);
    assert.match(reserve, /RETURNS TABLE\(result text, run_id uuid\)/i);
  });

  it("enables RLS and grants tables and RPCs only to service_role", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    assert.match(sql, /ALTER TABLE public\.memory_v3_shadow_identities ENABLE ROW LEVEL SECURITY/i);
    assert.match(sql, /ALTER TABLE public\.memory_v3_shadow_runs ENABLE ROW LEVEL SECURITY/i);
    assert.doesNotMatch(sql, /CREATE POLICY/i);
    assert.equal((sql.match(/SECURITY DEFINER/gi) ?? []).length, 3);
    assert.equal((sql.match(/SET search_path = ''/gi) ?? []).length, 3);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.reserve_memory_v3_shadow_run[\s\S]*TO service_role/i);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.complete_memory_v3_shadow_run[\s\S]*TO service_role/i);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.purge_memory_v3_shadow_runs[\s\S]*TO service_role/i);
    assert.doesNotMatch(sql, /GRANT[\s\S]{0,180}TO (anon|authenticated)/i);
    assert.match(sql, /REVOKE ALL ON TABLE public\.memory_v3_shadow_identities FROM PUBLIC, anon, authenticated/i);
    assert.match(sql, /REVOKE ALL ON TABLE public\.memory_v3_shadow_runs FROM PUBLIC, anon, authenticated/i);
  });

  it("purges only payload rows and preserves the durable identity", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    const purge = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.purge_memory_v3_shadow_runs"));
    assert.match(purge, /DELETE FROM public\.memory_v3_shadow_runs/i);
    assert.doesNotMatch(purge, /DELETE FROM public\.memory_v3_shadow_identities/i);
    assert.match(purge, /created_at < pg_catalog\.now\(\) - INTERVAL '30 days'/i);
    assert.ok(sql.indexOf("DELETE FROM public.memory_v3_shadow_runs") < sql.indexOf("FROM public.memory_v3_shadow_identities"));
  });

  it("completes only the owning run while it is still reserved", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    const complete = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.complete_memory_v3_shadow_run"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.purge_memory_v3_shadow_runs"),
    );
    assert.match(complete, /UPDATE public\.memory_v3_shadow_runs/i);
    assert.match(complete, /WHERE id = p_run_id\s+AND user_id = p_user_id\s+AND status = 'reserved'/i);
    assert.match(complete, /IF NOT FOUND THEN\s+RAISE EXCEPTION/i);
  });

  it("relies on conversation deletion cascades without adding legacy read integration", () => {
    const roomDeletion = readFileSync(new URL("../../../migrations/20260605120000_020_room_deletion.sql", import.meta.url), "utf8");
    assert.match(roomDeletion, /DELETE FROM public\.conversations WHERE user_id = uid/i);
    for (const path of ["../context.ts", "../memory.ts", "../memoryLayersV2.ts", "../../staysee-chat/index.ts"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.doesNotMatch(source, /memory_v3_shadow_(runs|identities)/i, path);
    }
  });
});

describe("Memory V3 shadow store reservation", () => {
  it("accepts a PromiseLike rpc boundary used by Supabase query builders", async () => {
    const source = readFileSync(new URL("./shadowStore.ts", import.meta.url), "utf8");
    assert.match(source, /rpc\(name: string, args: Record<string, unknown>\): PromiseLike<\{ data: unknown; error: unknown \}>/);

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return {
          then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
            onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ): PromiseLike<TResult1 | TResult2> {
            return Promise.resolve({
              data: [{ result: "reserved", run_id: RUN_ID }],
              error: null,
            }).then(onfulfilled, onrejected);
          },
        };
      },
    };
    const result = await createMemoryV3ShadowStore(client).reserve(reservationInput());
    assert.deepEqual(result, { status: "reserved", runId: RUN_ID });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "reserve_memory_v3_shadow_run");
  });

  it("accepts the Supabase-style rpc method from a client prototype", async () => {
    class SupabaseStyleClient {
      calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      readonly unrelatedRuntimeField = "ignored";

      async rpc(name: string, args: Record<string, unknown>) {
        this.calls.push({ name, args });
        return { data: [{ result: "reserved", run_id: RUN_ID }], error: null };
      }
    }
    const client = new SupabaseStyleClient();
    const result = await createMemoryV3ShadowStore(client).reserve(reservationInput());
    assert.deepEqual(result, { status: "reserved", runId: RUN_ID });
    assert.equal(client.calls.length, 1);
  });

  it("projects reserved, duplicate, and daily-cap RPC results", async () => {
    for (const [row, expected] of [
      [{ result: "reserved", run_id: RUN_ID }, { status: "reserved", runId: RUN_ID }],
      [{ result: "duplicate", run_id: null }, { status: "duplicate" }],
      [{ result: "daily_cap", run_id: null }, { status: "daily_cap" }],
    ] as const) {
      const fake = fakeClient([{ data: [row], error: null }]);
      const input = reservationInput();
      const result = await createMemoryV3ShadowStore(fake.client).reserve(input);
      assert.deepEqual(result, expected);
      assert.deepEqual(fake.calls, [{
        name: "reserve_memory_v3_shadow_run",
        args: {
          p_user_id: USER_ID,
          p_conversation_id: CONVERSATION_ID,
          p_extractor_version: input.extractorVersion,
          p_model: input.model,
          p_input_hash: INPUT_HASH,
          p_source_last_message_id: MESSAGE_ID,
          p_source_last_created_at: input.sourceLastCreatedAt,
          p_message_count: 2,
          p_user_message_count: 1,
        },
      }]);
    }
  });

  it("rejects malformed RPC data and hides database failures", async () => {
    const malformed = [null, {}, [], [{ result: "reserved", run_id: null }], [{ result: "other", run_id: RUN_ID }], [{ result: "duplicate", run_id: RUN_ID }]];
    for (const data of malformed) {
      const fake = fakeClient([{ data, error: null }]);
      await captureStoreError(() => createMemoryV3ShadowStore(fake.client).reserve(reservationInput()));
    }
    for (const response of [
      { data: null, error: { message: RAW_SECRET } },
      new Error(RAW_SECRET),
    ]) {
      const fake = fakeClient([response]);
      await captureStoreError(() => createMemoryV3ShadowStore(fake.client).reserve(reservationInput()));
    }
  });

  it("rejects invalid or accessor input before calling RPC", async () => {
    const fake = fakeClient([]);
    const getterInput = reservationInput();
    let getterCalls = 0;
    Object.defineProperty(getterInput, "inputHash", { enumerable: true, get() { getterCalls += 1; return INPUT_HASH; } });
    for (const input of [
      { ...reservationInput(), inputHash: "ABC" },
      { ...reservationInput(), messageCount: 61 },
      { ...reservationInput(), userMessageCount: 3 },
      getterInput,
    ]) await captureStoreError(() => createMemoryV3ShadowStore(fake.client).reserve(input));
    assert.equal(getterCalls, 0);
    assert.equal(fake.calls.length, 0);
  });
});

describe("Memory V3 shadow store completion", () => {
  it("writes a copied normalized success with trusted usage", async () => {
    const fake = fakeClient([{ data: null, error: null }]);
    const original = extraction();
    await createMemoryV3ShadowStore(fake.client).succeed({
      runId: RUN_ID,
      userId: USER_ID,
      extraction: original,
      itemCount: 1,
      evidenceCount: 1,
      usage: { promptTokens: 100, completionTokens: 50, costUsd: 0.0001 },
    });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].name, "complete_memory_v3_shadow_run");
    const args = fake.calls[0].args;
    assert.equal(args.p_status, "succeeded");
    assert.equal(args.p_diagnostic_code, null);
    assert.equal(args.p_item_count, 1);
    assert.equal(args.p_evidence_count, 1);
    assert.deepEqual(args.p_extraction, original);
    assert.notEqual(args.p_extraction, original);
    assert.notEqual((args.p_extraction as MemoryV3Extraction).items, original.items);
    assert.deepEqual([args.p_prompt_tokens, args.p_completion_tokens, args.p_cost_usd], [100, 50, 0.0001]);
    assert.match(String(args.p_completed_at), /^\d{4}-\d{2}-\d{2}T/);
    (args.p_extraction as MemoryV3Extraction).items[0].claim = "changed";
    assert.equal(original.items[0].claim, "Синтетический факт");
  });

  it("writes null usage as three null database fields", async () => {
    const fake = fakeClient([{ data: null, error: null }]);
    await createMemoryV3ShadowStore(fake.client).succeed({ runId: RUN_ID, userId: USER_ID, extraction: extraction(), itemCount: 1, evidenceCount: 1, usage: null });
    assert.deepEqual(
      [fake.calls[0].args.p_prompt_tokens, fake.calls[0].args.p_completion_tokens, fake.calls[0].args.p_cost_usd],
      [null, null, null],
    );
  });

  it("accepts every date-time precision already normalized by the Task 2 contract", async () => {
    const fake = fakeClient([{ data: null, error: null }]);
    const normalized = extraction();
    normalized.items[0].eventTimeStart = "2026-09-05T10:00Z";
    normalized.items[0].eventTimeEnd = "2026-09-05T10:00:00.123456789Z";
    normalized.evidence[0].mentionTime = "2026-09-05T10:00:00.123456789Z";
    await createMemoryV3ShadowStore(fake.client).succeed({
      runId: RUN_ID,
      userId: USER_ID,
      extraction: normalized,
      itemCount: 1,
      evidenceCount: 1,
      usage: null,
    });
    assert.equal(fake.calls.length, 1);
  });

  it("writes only allowlisted terminal failures", async () => {
    for (const diagnosticCode of DIAGNOSTICS) {
      const fake = fakeClient([{ data: null, error: null }]);
      await createMemoryV3ShadowStore(fake.client).fail({ runId: RUN_ID, userId: USER_ID, diagnosticCode });
      const args = fake.calls[0].args;
      assert.equal(fake.calls[0].name, "complete_memory_v3_shadow_run");
      assert.equal(args.p_status, "failed");
      assert.equal(args.p_diagnostic_code, diagnosticCode);
      assert.deepEqual([args.p_item_count, args.p_evidence_count, args.p_extraction, args.p_prompt_tokens, args.p_completion_tokens, args.p_cost_usd], [null, null, null, null, null, null]);
    }
    const fake = fakeClient([]);
    await captureStoreError(() => createMemoryV3ShadowStore(fake.client).fail({ runId: RUN_ID, userId: USER_ID, diagnosticCode: "database said something" as MemoryV3StoredDiagnostic }));
    assert.equal(fake.calls.length, 0);
  });

  it("rejects non-normalized extraction, mismatched counts, and untrusted usage before RPC", async () => {
    const fake = fakeClient([]);
    const withGetter = extraction();
    let getterCalls = 0;
    Object.defineProperty(withGetter.items[0], "claim", { enumerable: true, get() { getterCalls += 1; return "secret"; } });
    for (const input of [
      { runId: RUN_ID, userId: USER_ID, extraction: { ...extraction(), extra: true }, itemCount: 1, evidenceCount: 1, usage: null },
      { runId: RUN_ID, userId: USER_ID, extraction: extraction(), itemCount: 2, evidenceCount: 1, usage: null },
      { runId: RUN_ID, userId: USER_ID, extraction: extraction(), itemCount: 1, evidenceCount: 1, usage: { promptTokens: -1, completionTokens: 1, costUsd: 0 } },
      { runId: RUN_ID, userId: USER_ID, extraction: withGetter, itemCount: 1, evidenceCount: 1, usage: null },
    ]) await captureStoreError(() => createMemoryV3ShadowStore(fake.client).succeed(input as never));
    assert.equal(getterCalls, 0);
    assert.equal(fake.calls.length, 0);
  });

  it("hides database errors during terminal writes", async () => {
    for (const operation of ["succeed", "fail"] as const) {
      const fake = fakeClient([{ data: null, error: { message: RAW_SECRET } }]);
      const store = createMemoryV3ShadowStore(fake.client);
      if (operation === "succeed") {
        await captureStoreError(() => store.succeed({ runId: RUN_ID, userId: USER_ID, extraction: extraction(), itemCount: 1, evidenceCount: 1, usage: null }));
      } else {
        await captureStoreError(() => store.fail({ runId: RUN_ID, userId: USER_ID, diagnosticCode: "unknown_failure" }));
      }
    }
  });
});
