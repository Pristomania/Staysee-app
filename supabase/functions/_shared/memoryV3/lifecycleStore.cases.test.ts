import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { MemoryV3Extraction } from "./contract.ts";
import { createEmptyMemoryV3LifecycleState } from "./lifecycleReducer.ts";
import {
  createMemoryV3LifecycleStore,
  type MemoryV3LifecycleStoredDiagnostic,
} from "./lifecycleStore.ts";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MESSAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INPUT_HASH = "e".repeat(64);
const RAW_SECRET = "RAW_LIFECYCLE_DATABASE_SECRET_SENTINEL";

const DIAGNOSTICS: MemoryV3LifecycleStoredDiagnostic[] = [
  "invalid_source", "state_too_large", "extractor_transport_failed",
  "extractor_parse_invalid", "extractor_shape_invalid", "extractor_contract_invalid",
  "reconciler_request_too_large", "reconciler_transport_failed",
  "reconciler_parse_invalid", "reconciler_shape_invalid", "reconciler_contract_invalid",
  "state_conflict", "state_write_failed", "reservation_failed", "unknown_failure",
];

function reservationInput() {
  return {
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    pipelineVersion: "memory-v3-lifecycle-shadow-v1" as const,
    extractorVersion: "memory-v3-openrouter-gemini-3.7-flash-shadow-v2",
    reconcilerVersion: "memory-v3-lifecycle-reconciler-v1",
    model: "google/gemini-3.7-flash" as const,
    inputHash: INPUT_HASH,
    sourceLastMessageId: MESSAGE_ID,
    sourceLastCreatedAt: "2026-09-14T10:00:00.000Z",
    messageCount: 2,
    userMessageCount: 1,
  };
}

function emptyState(revision = 0) {
  const state = createEmptyMemoryV3LifecycleState({ userId: USER_ID });
  return { ...state, stateRevision: revision };
}

function emptyExtraction(): MemoryV3Extraction {
  return {
    run: {
      caseId: `memory-v3-shadow:${USER_ID}:${CONVERSATION_ID}`,
      extractorVersion: "memory-v3-openrouter-gemini-3.7-flash-shadow-v2",
    },
    items: [],
    evidence: [],
  };
}

function successWrite(changed = false) {
  return {
    runId: RUN_ID,
    userId: USER_ID,
    expectedStateRevision: 0,
    state: { ...emptyState(changed ? 1 : 0), nextMemoryOrdinal: changed ? 2 : 1 },
    changed,
    extraction: emptyExtraction(),
    operations: [],
    transitions: [],
    extractorUsage: null,
    reconcilerUsage: { promptTokens: 10, completionTokens: 2, costUsd: 0.001 },
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
  assert.equal(caught.name, "MemoryV3LifecycleStoreError");
  assert.equal(caught.message, "[memory-v3:lifecycle-store] operation failed");
  assert.equal(caught.message.includes(RAW_SECRET), false);
  assert.equal(JSON.stringify(caught).includes(RAW_SECRET), false);
  assert.equal("cause" in caught, false);
  return caught;
}

describe("Memory V3 lifecycle migration", () => {
  const migrationUrl = new URL("../../../migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql", import.meta.url);
  const priorScheduleUrl = new URL("../../../migrations/20260914193000_033_memory_v3_shadow_retention_schedule.sql", import.meta.url);

  it("creates all five normalized service-role-only tables", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    for (const table of ["heads", "items", "evidence", "identities", "runs"]) {
      assert.match(sql, new RegExp(`CREATE TABLE public\\.memory_v3_lifecycle_shadow_${table}`, "i"));
      assert.match(sql, new RegExp(`ALTER TABLE public\\.memory_v3_lifecycle_shadow_${table} ENABLE ROW LEVEL SECURITY`, "i"));
      assert.match(sql, new RegExp(`REVOKE ALL ON TABLE public\\.memory_v3_lifecycle_shadow_${table} FROM PUBLIC, anon, authenticated`, "i"));
      assert.match(sql, new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\\.memory_v3_lifecycle_shadow_${table} TO service_role`, "i"));
    }
    assert.doesNotMatch(sql, /CREATE POLICY/i);
    assert.match(sql, /PRIMARY KEY \(user_id, memory_key\)/i);
    assert.match(sql, /PRIMARY KEY \(user_id, conversation_id, pipeline_version, input_hash\)/i);
    assert.match(sql, /FOREIGN KEY \(user_id, memory_key\)[\s\S]*ON DELETE CASCADE/i);
    assert.match(sql, /UNIQUE \(user_id, conversation_id, pipeline_version, input_hash\)/i);
  });

  it("locks ownership, deletion, CAS, bounded state, and terminal run shapes", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    assert.match(sql, /m\.conversation_id = \(evidence->>'conversationId'\)::uuid[\s\S]*c\.user_id = p_user_id/i);
    assert.match(sql, /m\.conversation_id = v_run_conversation_id[\s\S]*c\.user_id = p_user_id/i);
    assert.match(sql, /BEFORE DELETE ON public\.messages/i);
    assert.match(sql, /BEFORE DELETE ON public\.conversations/i);
    assert.match(sql, /DELETE FROM public\.memory_v3_lifecycle_shadow_items/i);
    assert.match(sql, /jsonb_array_length\([^)]*items[^)]*\) > 100/i);
    assert.match(sql, /v_evidence_count > 500/i);
    assert.match(sql, /FOR UPDATE/i);
    assert.match(sql, /state_revision = p_expected_state_revision/i);
    assert.match(sql, /diagnostic_code = 'state_conflict'[\s\S]*result := 'state_conflict'/i);
    assert.match(sql, /IF v_actual_changed THEN[\s\S]*state_revision = state_revision \+ 1/i);
    assert.match(sql, /v_actual_changed :=[\s\S]*p_changed IS DISTINCT FROM v_actual_changed/i);
    assert.match(sql, /FOR UPDATE[\s\S]*v_locked_run_id/i);
    assert.equal((sql.match(/ORDER BY e\.conversation_id, e\.source_message_id, e\.relation COLLATE "C"/g) ?? []).length, 2);
    assert.equal((sql.match(/ORDER BY i\.memory_key COLLATE "C"/g) ?? []).length, 2);
    assert.match(sql, /status IN \('reserved', 'succeeded', 'failed'\)/i);
    for (const diagnostic of DIAGNOSTICS) assert.ok(sql.includes(`'${diagnostic}'`), diagnostic);
  });

  it("uses four empty-search-path RPCs, an atomic UTC cap of one, and durable duplicate identity", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    for (const fn of [
      "reserve_memory_v3_lifecycle_shadow_run", "fail_memory_v3_lifecycle_shadow_run",
      "apply_memory_v3_lifecycle_shadow_state", "purge_memory_v3_lifecycle_shadow_runs",
    ]) {
      assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}`, "i"));
      assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]{0,900}TO service_role`, "i"));
    }
    assert.equal((sql.match(/SECURITY DEFINER/gi) ?? []).length >= 6, true);
    assert.equal((sql.match(/SET search_path = ''/gi) ?? []).length >= 6, true);
    assert.match(sql, /pg_catalog\.pg_advisory_xact_lock/i);
    assert.match(sql, /AT TIME ZONE 'UTC'/i);
    assert.match(sql, /IF v_daily_count >= 1/i);
    assert.match(sql, /ON CONFLICT \(user_id, conversation_id, pipeline_version, input_hash\) DO NOTHING/i);
  });

  it("purges only old run payloads and schedules a separate daily lifecycle job", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    const purgeStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.purge_memory_v3_lifecycle_shadow_runs");
    const purgeEnd = sql.indexOf("CREATE OR REPLACE FUNCTION public.delete_memory_v3_lifecycle_items_for_message", purgeStart);
    const purge = sql.slice(purgeStart, purgeEnd);
    assert.match(purge, /DELETE FROM public\.memory_v3_lifecycle_shadow_runs/i);
    for (const stable of ["identities", "heads", "items", "evidence"]) {
      assert.doesNotMatch(purge, new RegExp(`DELETE FROM public\\.memory_v3_lifecycle_shadow_${stable}`, "i"));
    }
    assert.match(purge, /INTERVAL '30 days'/i);
    assert.match(sql, /memory-v3-lifecycle-shadow-purge-daily/i);
    assert.match(sql, /'29 3 \* \* \*'/i);
    assert.equal(readFileSync(priorScheduleUrl, "utf8").includes("memory-v3-lifecycle-shadow-purge-daily"), false);
  });
});

describe("Memory V3 lifecycle store", () => {
  it("reserves once with exact arguments and returns the transaction snapshot", async () => {
    const state = emptyState();
    const fake = fakeClient([{ data: [{ result: "reserved", run_id: RUN_ID, expected_state_revision: 0, state }], error: null }]);
    const result = await createMemoryV3LifecycleStore(fake.client).reserve(reservationInput());
    assert.deepEqual(result, { status: "reserved", runId: RUN_ID, expectedStateRevision: 0, state });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].name, "reserve_memory_v3_lifecycle_shadow_run");
    assert.deepEqual(fake.calls[0].args, {
      p_user_id: USER_ID, p_conversation_id: CONVERSATION_ID,
      p_pipeline_version: "memory-v3-lifecycle-shadow-v1",
      p_extractor_version: "memory-v3-openrouter-gemini-3.7-flash-shadow-v2",
      p_reconciler_version: "memory-v3-lifecycle-reconciler-v1",
      p_model: "google/gemini-3.7-flash", p_input_hash: INPUT_HASH,
      p_source_last_message_id: MESSAGE_ID,
      p_source_last_created_at: "2026-09-14T10:00:00.000Z",
      p_message_count: 2, p_user_message_count: 1,
    });
  });

  it("accepts duplicate and daily-cap rows only with null payload columns", async () => {
    for (const status of ["duplicate", "daily_cap"] as const) {
      const fake = fakeClient([{ data: [{ result: status, run_id: null, expected_state_revision: null, state: null }], error: null }]);
      assert.deepEqual(await createMemoryV3LifecycleStore(fake.client).reserve(reservationInput()), { status });
      assert.equal(fake.calls.length, 1);
    }
  });

  it("rejects invalid reservation constants and counts before RPC", async () => {
    for (const mutation of [
      { pipelineVersion: "memory-v3-lifecycle-shadow-v2" },
      { model: "openai/gpt-5.6-luna" },
      { inputHash: "not-a-hash" },
      { messageCount: 61 },
      { userMessageCount: 3 },
    ]) {
      const fake = fakeClient([]);
      await captureStoreError(() => createMemoryV3LifecycleStore(fake.client).reserve({ ...reservationInput(), ...mutation } as never));
      assert.equal(fake.calls.length, 0);
    }
  });

  it("uses a prototype rpc method and a prototype PromiseLike then exactly once", async () => {
    const calls: unknown[] = [];
    class Thenable { constructor(private value: unknown) {} then(resolve: (value: unknown) => void) { resolve(this.value); } }
    class Client { rpc(name: string, args: unknown) { calls.push({ name, args }); return new Thenable({ data: [{ result: "duplicate", run_id: null, expected_state_revision: null, state: null }], error: null }); } }
    assert.deepEqual(await createMemoryV3LifecycleStore(new Client()).reserve(reservationInput()), { status: "duplicate" });
    assert.equal(calls.length, 1);
  });

  it("writes every allowlisted failure with exactly one RPC", async () => {
    for (const diagnosticCode of DIAGNOSTICS) {
      const fake = fakeClient([{ data: null, error: null }]);
      await createMemoryV3LifecycleStore(fake.client).fail({ runId: RUN_ID, userId: USER_ID, diagnosticCode });
      assert.deepEqual(fake.calls, [{
        name: "fail_memory_v3_lifecycle_shadow_run",
        args: { p_run_id: RUN_ID, p_user_id: USER_ID, p_diagnostic_code: diagnosticCode },
      }]);
    }
  });

  it("rejects unlisted failure diagnostics and malformed completion responses without retry", async () => {
    const local = fakeClient([]);
    await captureStoreError(() => createMemoryV3LifecycleStore(local.client).fail({
      runId: RUN_ID, userId: USER_ID, diagnosticCode: "RAW_NOT_ALLOWLISTED" as never,
    }));
    assert.equal(local.calls.length, 0);

    for (const response of [{ data: {}, error: null }, { data: null, error: { detail: RAW_SECRET } }, new Error(RAW_SECRET)]) {
      const fake = fakeClient([response]);
      await captureStoreError(() => createMemoryV3LifecycleStore(fake.client).fail({
        runId: RUN_ID, userId: USER_ID, diagnosticCode: "unknown_failure",
      }));
      assert.equal(fake.calls.length, 1);
    }
  });

  it("applies changed and unchanged state with exact sanitized audit arguments", async () => {
    for (const changed of [false, true]) {
      const expectedRevision = changed ? 1 : 0;
      const fake = fakeClient([{ data: [{ result: "succeeded", resulting_state_revision: expectedRevision }], error: null }]);
      const result = await createMemoryV3LifecycleStore(fake.client).compareAndSwap(successWrite(changed));
      assert.deepEqual(result, { status: "succeeded", resultingStateRevision: expectedRevision });
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].name, "apply_memory_v3_lifecycle_shadow_state");
      assert.deepEqual(Object.keys(fake.calls[0].args), [
        "p_run_id", "p_user_id", "p_expected_state_revision", "p_state", "p_changed",
        "p_extraction", "p_operations", "p_transitions", "p_extractor_usage", "p_reconciler_usage",
      ]);
    }
  });

  it("returns state_conflict only with a null resulting revision", async () => {
    const fake = fakeClient([{ data: [{ result: "state_conflict", resulting_state_revision: null }], error: null }]);
    assert.deepEqual(await createMemoryV3LifecycleStore(fake.client).compareAndSwap(successWrite()), { status: "state_conflict" });
  });

  it("rejects invalid CAS audit, usage, and result rows before any retry", async () => {
    const invalidInputs = [
      { ...successWrite(), expectedStateRevision: 2 },
      { ...successWrite(), operations: [{ type: "create", candidateLocalItemKey: "missing", targetMemoryKey: null }] },
      { ...successWrite(), extractorUsage: { promptTokens: -1, completionTokens: 0, costUsd: 0 } },
      { ...successWrite(), transitions: [{ type: "unknown", candidateLocalItemKey: null, targetMemoryKey: null, resultingMemoryKey: null }] },
    ];
    for (const input of invalidInputs) {
      const fake = fakeClient([]);
      await captureStoreError(() => createMemoryV3LifecycleStore(fake.client).compareAndSwap(input as never));
      assert.equal(fake.calls.length, 0);
    }
    for (const response of [
      { data: [{ result: "succeeded", resulting_state_revision: 9 }], error: null },
      { data: [{ result: "state_conflict", resulting_state_revision: 0 }], error: null },
      { data: null, error: { detail: RAW_SECRET } },
      new Error(RAW_SECRET),
    ]) {
      const fake = fakeClient([response]);
      await captureStoreError(() => createMemoryV3LifecycleStore(fake.client).compareAndSwap(successWrite()));
      assert.equal(fake.calls.length, 1);
    }
  });

  it("passes fresh JSON audit copies rather than caller-owned references", async () => {
    const input = successWrite();
    const fake = fakeClient([{ data: [{ result: "succeeded", resulting_state_revision: 0 }], error: null }]);
    await createMemoryV3LifecycleStore(fake.client).compareAndSwap(input);
    const args = fake.calls[0].args;
    assert.notEqual(args.p_state, input.state);
    assert.notEqual(args.p_extraction, input.extraction);
    assert.notEqual(args.p_operations, input.operations);
    assert.notEqual(args.p_transitions, input.transitions);
    assert.notEqual(args.p_reconciler_usage, input.reconcilerUsage);
  });

  it("rejects getters, malformed rows, spoofed inputs, and database errors without leaks or retry", async () => {
    let getterCalls = 0;
    const input = reservationInput() as Record<string, unknown>;
    Object.defineProperty(input, "messageCount", { enumerable: true, get() { getterCalls += 1; return 2; } });
    const local = fakeClient([]);
    await captureStoreError(() => createMemoryV3LifecycleStore(local.client).reserve(input as never));
    assert.equal(getterCalls, 0);
    assert.equal(local.calls.length, 0);

    for (const response of [
      { data: [{ result: "reserved", run_id: RUN_ID, expected_state_revision: 0, state: { bad: true } }], error: null },
      { data: null, error: { message: RAW_SECRET } },
      new Error(RAW_SECRET),
    ]) {
      const fake = fakeClient([response]);
      await captureStoreError(() => createMemoryV3LifecycleStore(fake.client).reserve(reservationInput()));
      assert.equal(fake.calls.length, 1);
    }
  });

  it("rejects revoked proxies and never trusts attacker-controlled property names", async () => {
    const revoked = Proxy.revocable(reservationInput(), {});
    revoked.revoke();
    const fake = fakeClient([]);
    await captureStoreError(() => createMemoryV3LifecycleStore(fake.client).reserve(revoked.proxy));
    assert.equal(fake.calls.length, 0);

    const cyclic = successWrite() as Record<string, unknown>;
    cyclic.SUPER_SECRET_PROPERTY_NAME = cyclic;
    await captureStoreError(() => createMemoryV3LifecycleStore(fake.client).compareAndSwap(cyclic as never));
    assert.equal(fake.calls.length, 0);
  });
});
