import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { MemoryV3Extraction } from "./contract.ts";
import { MEMORY_V3_DIALOGUE_SCHEMA_VERSION } from "./dialogueContract.ts";
import {
  createMemoryV3DialogueStore,
  getMemoryV3DialogueReserveStage,
  type MemoryV3DialogueStoredDiagnostic,
} from "./dialogueStore.ts";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MESSAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INPUT_HASH = "e".repeat(64);
const RAW_SECRET = "RAW_DIALOGUE_DATABASE_SECRET_SENTINEL";

const DIAGNOSTICS: MemoryV3DialogueStoredDiagnostic[] = [
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
    pipelineVersion: "memory-v3-dialogue-v1" as const,
    extractorVersion: "memory-v3-openrouter-gemini-3.7-flash-shadow-v2",
    reconcilerVersion: "memory-v3-dialogue-reconciler-v1",
    model: "google/gemini-3.7-flash" as const,
    inputHash: INPUT_HASH,
    sourceLastMessageId: MESSAGE_ID,
    sourceLastCreatedAt: "2026-09-14T10:00:00.000Z",
    messageCount: 2,
    userMessageCount: 1,
  };
}

// dialogueReducer.ts (a live-wiring / domain-2 concern, not built in this
// task) is not mirrored here -- an empty state is just the fixed shape
// every dialogue head starts from, constructed directly.
function emptyState(revision = 0) {
  return {
    schemaVersion: MEMORY_V3_DIALOGUE_SCHEMA_VERSION,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    stateRevision: revision,
    nextMemoryOrdinal: revision === 0 ? 1 : revision + 1,
    items: [],
  };
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
    conversationId: CONVERSATION_ID,
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
  assert.equal(caught.name, "MemoryV3DialogueStoreError");
  assert.equal(caught.message, "[memory-v3:dialogue-store] operation failed");
  assert.equal(caught.message.includes(RAW_SECRET), false);
  assert.equal(JSON.stringify(caught).includes(RAW_SECRET), false);
  assert.equal("cause" in caught, false);
  return caught;
}

describe("Memory V3 dialogue migration", () => {
  const migrationUrl = new URL("../../../migrations/20260922130000_039_memory_v3_dialogue_isolation.sql", import.meta.url);

  it("creates all five normalized service-role-only tables keyed by user and conversation", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    for (const table of ["heads", "items", "evidence", "identities", "runs"]) {
      assert.match(sql, new RegExp(`CREATE TABLE public\\.memory_v3_dialogue_${table}`, "i"));
      assert.match(sql, new RegExp(`ALTER TABLE public\\.memory_v3_dialogue_${table} ENABLE ROW LEVEL SECURITY`, "i"));
      assert.match(sql, new RegExp(`REVOKE ALL ON TABLE public\\.memory_v3_dialogue_${table} FROM PUBLIC, anon, authenticated`, "i"));
      assert.match(sql, new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\\.memory_v3_dialogue_${table} TO service_role`, "i"));
    }
    assert.doesNotMatch(sql, /CREATE POLICY/i);
    assert.match(sql, /PRIMARY KEY \(user_id, conversation_id, memory_key\)/i);
    assert.match(sql, /PRIMARY KEY \(user_id, conversation_id, pipeline_version, input_hash\)/i);
    assert.match(sql, /FOREIGN KEY \(user_id, conversation_id, memory_key\)[\s\S]*ON DELETE CASCADE/i);
    assert.match(sql, /UNIQUE \(user_id, conversation_id, pipeline_version, input_hash\)/i);
    // The whole point of this table set: heads/items/evidence carry
    // conversation_id in their own primary key, unlike the user-only
    // lifecycle-shadow originals.
    assert.match(sql, /PRIMARY KEY \(user_id, conversation_id\)/i);
  });

  it("folds conversation_id into the state-write advisory lock, not just the row lock", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    assert.match(
      sql,
      /pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(\s*p_user_id::text \|\| ':' \|\| p_conversation_id::text/i,
    );
  });

  it("shares the daily paid-call budget across a user's dialogues with its own separate lock", () => {
    // Product decision (22.09.2026): the cap is one reservation per
    // PERSON per day, shared across every dialogue -- not one per
    // dialogue. That makes the count query a shared resource two
    // concurrent dialogues could race on, so it needs its own lock,
    // independent of the per-conversation state-write lock above.
    const sql = readFileSync(migrationUrl, "utf8");
    const reserveStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.reserve_memory_v3_dialogue_run");
    const reserveEnd = sql.indexOf("CREATE OR REPLACE FUNCTION public.fail_memory_v3_dialogue_run", reserveStart);
    const reserve = sql.slice(reserveStart, reserveEnd);
    assert.equal((reserve.match(/pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(/g) ?? []).length, 2);
    assert.match(
      reserve,
      /pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(\s*p_user_id::text \|\| ':' \|\|\s*\(\(pg_catalog\.now\(\) AT TIME ZONE 'UTC'\)::date\)::text, 1\)\)/i,
    );
    const capLockIndex = reserve.search(/hashtextextended\(\s*p_user_id::text \|\| ':' \|\|\s*\(\(pg_catalog\.now/i);
    const countIndex = reserve.indexOf("SELECT pg_catalog.count(*)::integer INTO v_daily_count");
    assert.equal(capLockIndex >= 0 && capLockIndex < countIndex, true);
    // The count itself must span every conversation of the user --
    // no "AND conversation_id = p_conversation_id" on this specific query.
    const countQuery = reserve.slice(countIndex, reserve.indexOf(";", countIndex));
    assert.equal(countQuery.includes("conversation_id"), false);
    assert.match(countQuery, /WHERE user_id = p_user_id/i);
  });

  it("locks ownership to this conversation specifically, deletion, CAS, bounded state, and terminal run shapes", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    assert.equal((sql.match(/m\.conversation_id = p_conversation_id[\s\S]{0,80}c\.user_id = p_user_id/gi) ?? []).length >= 2, true);
    assert.match(sql, /BEFORE DELETE ON public\.messages/i);
    assert.match(sql, /BEFORE DELETE ON public\.conversations/i);
    assert.match(sql, /DELETE FROM public\.memory_v3_dialogue_items/i);
    assert.match(sql, /DELETE FROM public\.memory_v3_dialogue_heads WHERE conversation_id = OLD\.id/i);
    assert.match(sql, /jsonb_array_length\([^)]*items[^)]*\) > 100/i);
    assert.match(sql, /v_evidence_count > 500/i);
    assert.match(sql, /FOR UPDATE/i);
    assert.match(sql, /state_revision = p_expected_state_revision/i);
    assert.match(sql, /diagnostic_code = 'state_conflict'[\s\S]*result := 'state_conflict'/i);
    assert.match(sql, /IF v_actual_changed THEN[\s\S]*state_revision = state_revision \+ 1/i);
    assert.match(sql, /v_actual_changed :=[\s\S]*p_changed IS DISTINCT FROM v_actual_changed/i);
    assert.match(sql, /FOR UPDATE[\s\S]*v_locked_run_id/i);
    assert.equal((sql.match(/ORDER BY e\.source_message_id, e\.relation COLLATE "C"/g) ?? []).length, 2);
    assert.equal((sql.match(/ORDER BY i\.memory_key COLLATE "C"/g) ?? []).length, 2);
    assert.match(sql, /status IN \('reserved', 'succeeded', 'failed'\)/i);
    for (const diagnostic of DIAGNOSTICS) assert.ok(sql.includes(`'${diagnostic}'`), diagnostic);
  });

  it("computes the resulting revision before the PL/pgSQL IF condition", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    assert.match(sql, /v_resulting_state_revision bigint;/i);
    assert.match(
      sql,
      /v_resulting_state_revision\s*:=\s*p_expected_state_revision\s*\+\s*CASE WHEN v_actual_changed THEN 1 ELSE 0 END;/i,
    );
    assert.match(
      sql,
      /IF \(p_state->>'stateRevision'\)::bigint <> v_resulting_state_revision THEN/i,
    );
    assert.doesNotMatch(sql, /CASE WHEN v_actual_changed THEN 1 ELSE 0 END THEN/i);
  });

  it("uses five empty-search-path RPCs, an atomic UTC cap of one, and durable duplicate identity", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    for (const fn of [
      "reserve_memory_v3_dialogue_run", "fail_memory_v3_dialogue_run",
      "apply_memory_v3_dialogue_state", "load_memory_v3_dialogue_read_context",
      "purge_memory_v3_dialogue_runs",
    ]) {
      assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}`, "i"));
      assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]{0,900}TO service_role`, "i"));
    }
    assert.equal((sql.match(/SECURITY DEFINER/gi) ?? []).length >= 7, true);
    assert.equal((sql.match(/SET search_path = ''/gi) ?? []).length >= 7, true);
    assert.match(sql, /pg_catalog\.pg_advisory_xact_lock/i);
    assert.match(sql, /AT TIME ZONE 'UTC'/i);
    assert.match(sql, /IF v_daily_count >= 1/i);
    assert.match(sql, /ON CONFLICT \(user_id, conversation_id, pipeline_version, input_hash\) DO NOTHING/i);
  });

  it("purges only old run payloads and schedules a separate daily dialogue job", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    const purgeStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.purge_memory_v3_dialogue_runs");
    const purgeEnd = sql.indexOf("CREATE OR REPLACE FUNCTION public.delete_memory_v3_dialogue_items_for_message", purgeStart);
    const purge = sql.slice(purgeStart, purgeEnd);
    assert.match(purge, /DELETE FROM public\.memory_v3_dialogue_runs/i);
    for (const stable of ["identities", "heads", "items", "evidence"]) {
      assert.doesNotMatch(purge, new RegExp(`DELETE FROM public\\.memory_v3_dialogue_${stable}`, "i"));
    }
    assert.match(purge, /INTERVAL '30 days'/i);
    assert.match(sql, /memory-v3-dialogue-purge-daily/i);
    assert.match(sql, /'31 3 \* \* \*'/i);
  });
});

describe("Memory V3 dialogue store", () => {
  it("reserves once with exact arguments and returns the transaction snapshot", async () => {
    const state = emptyState();
    const fake = fakeClient([{ data: [{ result: "reserved", run_id: RUN_ID, expected_state_revision: 0, state }], error: null }]);
    const result = await createMemoryV3DialogueStore(fake.client).reserve(reservationInput());
    assert.deepEqual(result, { status: "reserved", runId: RUN_ID, expectedStateRevision: 0, state });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].name, "reserve_memory_v3_dialogue_run");
    assert.deepEqual(fake.calls[0].args, {
      p_user_id: USER_ID, p_conversation_id: CONVERSATION_ID,
      p_pipeline_version: "memory-v3-dialogue-v1",
      p_extractor_version: "memory-v3-openrouter-gemini-3.7-flash-shadow-v2",
      p_reconciler_version: "memory-v3-dialogue-reconciler-v1",
      p_model: "google/gemini-3.7-flash", p_input_hash: INPUT_HASH,
      p_source_last_message_id: MESSAGE_ID,
      p_source_last_created_at: "2026-09-14T10:00:00.000Z",
      p_message_count: 2, p_user_message_count: 1,
    });
  });

  it("accepts duplicate and daily-cap rows only with null payload columns", async () => {
    for (const status of ["duplicate", "daily_cap"] as const) {
      const fake = fakeClient([{ data: [{ result: status, run_id: null, expected_state_revision: null, state: null }], error: null }]);
      assert.deepEqual(await createMemoryV3DialogueStore(fake.client).reserve(reservationInput()), { status });
      assert.equal(fake.calls.length, 1);
    }
  });

  it("rejects invalid reservation constants and counts before RPC", async () => {
    for (const mutation of [
      { pipelineVersion: "memory-v3-dialogue-v2" },
      { model: "openai/gpt-5.6-luna" },
      { inputHash: "not-a-hash" },
      { messageCount: 61 },
      { userMessageCount: 3 },
    ]) {
      const fake = fakeClient([]);
      const caught = await captureStoreError(() => createMemoryV3DialogueStore(fake.client).reserve({ ...reservationInput(), ...mutation } as never));
      assert.equal(fake.calls.length, 0);
      // The generic message/name is what every external caller still
      // sees (captureStoreError already asserted that); the stage tag is
      // a side channel this file's own console-only diagnostics read.
      assert.equal(getMemoryV3DialogueReserveStage(caught), "invalid_input");
    }
  });

  it("tags reserve()'s own failure stage without ever changing the generic error callers see", async () => {
    // response_shape_invalid: the RPC replied, but not with exactly one row.
    const zeroRows = fakeClient([{ data: [], error: null }]);
    assert.equal(
      getMemoryV3DialogueReserveStage(await captureStoreError(() => createMemoryV3DialogueStore(zeroRows.client).reserve(reservationInput()))),
      "response_shape_invalid",
    );

    // duplicate_payload_invalid: a 'duplicate' row that isn't all-null otherwise.
    const dirtyDuplicate = fakeClient([{
      data: [{ result: "duplicate", run_id: RUN_ID, expected_state_revision: null, state: null }],
      error: null,
    }]);
    assert.equal(
      getMemoryV3DialogueReserveStage(await captureStoreError(() => createMemoryV3DialogueStore(dirtyDuplicate.client).reserve(reservationInput()))),
      "duplicate_payload_invalid",
    );

    // result_invalid: neither duplicate/daily_cap nor a well-formed 'reserved' row.
    const badResult = fakeClient([{
      data: [{ result: "reserved", run_id: "not-a-uuid", expected_state_revision: 0, state: {} }],
      error: null,
    }]);
    assert.equal(
      getMemoryV3DialogueReserveStage(await captureStoreError(() => createMemoryV3DialogueStore(badResult.client).reserve(reservationInput()))),
      "result_invalid",
    );

    // state_revision_mismatch: a well-formed reserved row whose state disagrees with its own revision.
    const mismatch = fakeClient([{
      data: [{
        result: "reserved", run_id: RUN_ID, expected_state_revision: 5,
        state: { ...emptyState(0) },
      }],
      error: null,
    }]);
    assert.equal(
      getMemoryV3DialogueReserveStage(await captureStoreError(() => createMemoryV3DialogueStore(mismatch.client).reserve(reservationInput()))),
      "state_revision_mismatch",
    );

    // A generic fail() from elsewhere in this file (e.g. the allowlisted
    // fail() path) carries no stage at all.
    assert.equal(getMemoryV3DialogueReserveStage(new Error("unrelated")), null);
    assert.equal(getMemoryV3DialogueReserveStage(null), null);
  });

  it("uses a prototype rpc method and a prototype PromiseLike then exactly once", async () => {
    const calls: unknown[] = [];
    class Thenable { constructor(private value: unknown) {} then(resolve: (value: unknown) => void) { resolve(this.value); } }
    class Client { rpc(name: string, args: unknown) { calls.push({ name, args }); return new Thenable({ data: [{ result: "duplicate", run_id: null, expected_state_revision: null, state: null }], error: null }); } }
    assert.deepEqual(await createMemoryV3DialogueStore(new Client()).reserve(reservationInput()), { status: "duplicate" });
    assert.equal(calls.length, 1);
  });

  it("writes every allowlisted failure with exactly one RPC", async () => {
    for (const diagnosticCode of DIAGNOSTICS) {
      const fake = fakeClient([{ data: null, error: null }]);
      await createMemoryV3DialogueStore(fake.client).fail({
        runId: RUN_ID, userId: USER_ID, diagnosticCode, transportDetail: null,
        reconcilerRawResponse: null, reconcilerContext: null,
      });
      assert.deepEqual(fake.calls, [{
        name: "fail_memory_v3_dialogue_run",
        args: {
          p_run_id: RUN_ID, p_user_id: USER_ID, p_diagnostic_code: diagnosticCode,
          p_transport_detail: null, p_reconciler_raw_response: null, p_reconciler_context: null,
        },
      }]);
    }
  });

  it("writes transportDetail through to the RPC when a specific transport diagnostic is known", async () => {
    const fake = fakeClient([{ data: null, error: null }]);
    await createMemoryV3DialogueStore(fake.client).fail({
      runId: RUN_ID, userId: USER_ID, diagnosticCode: "extractor_transport_failed", transportDetail: "provider_http_5xx",
      reconcilerRawResponse: null, reconcilerContext: null,
    });
    assert.deepEqual(fake.calls, [{
      name: "fail_memory_v3_dialogue_run",
      args: {
        p_run_id: RUN_ID, p_user_id: USER_ID, p_diagnostic_code: "extractor_transport_failed",
        p_transport_detail: "provider_http_5xx", p_reconciler_raw_response: null, p_reconciler_context: null,
      },
    }]);
  });

  it("writes reconcilerRawResponse through to the RPC when the reconciler replied before failing", async () => {
    const fake = fakeClient([{ data: null, error: null }]);
    await createMemoryV3DialogueStore(fake.client).fail({
      runId: RUN_ID, userId: USER_ID, diagnosticCode: "reconciler_contract_invalid", transportDetail: null,
      reconcilerRawResponse: '{"operations":[]}', reconcilerContext: null,
    });
    assert.deepEqual(fake.calls, [{
      name: "fail_memory_v3_dialogue_run",
      args: {
        p_run_id: RUN_ID, p_user_id: USER_ID, p_diagnostic_code: "reconciler_contract_invalid",
        p_transport_detail: null, p_reconciler_raw_response: '{"operations":[]}', p_reconciler_context: null,
      },
    }]);
  });

  it("writes reconcilerContext through to the RPC when the shadow runner captured it", async () => {
    const fake = fakeClient([{ data: null, error: null }]);
    const context = JSON.stringify({ state: {}, extraction: {}, bindings: {} });
    await createMemoryV3DialogueStore(fake.client).fail({
      runId: RUN_ID, userId: USER_ID, diagnosticCode: "reconciler_contract_invalid", transportDetail: null,
      reconcilerRawResponse: '{"operations":[]}', reconcilerContext: context,
    });
    assert.deepEqual(fake.calls, [{
      name: "fail_memory_v3_dialogue_run",
      args: {
        p_run_id: RUN_ID, p_user_id: USER_ID, p_diagnostic_code: "reconciler_contract_invalid",
        p_transport_detail: null, p_reconciler_raw_response: '{"operations":[]}', p_reconciler_context: context,
      },
    }]);
  });

  it("rejects a transportDetail that is not null and not a non-empty string", async () => {
    for (const bad of ["", "   ", 123, {}]) {
      const local = fakeClient([]);
      await captureStoreError(() => createMemoryV3DialogueStore(local.client).fail({
        runId: RUN_ID, userId: USER_ID, diagnosticCode: "unknown_failure", transportDetail: bad as never,
        reconcilerRawResponse: null, reconcilerContext: null,
      }));
      assert.equal(local.calls.length, 0);
    }
  });

  it("rejects a reconcilerRawResponse that is not null and not a non-empty string", async () => {
    for (const bad of ["", "   ", 123, {}]) {
      const local = fakeClient([]);
      await captureStoreError(() => createMemoryV3DialogueStore(local.client).fail({
        runId: RUN_ID, userId: USER_ID, diagnosticCode: "unknown_failure", transportDetail: null,
        reconcilerRawResponse: bad as never, reconcilerContext: null,
      }));
      assert.equal(local.calls.length, 0);
    }
  });

  it("rejects a reconcilerContext that is not null and not a non-empty string", async () => {
    for (const bad of ["", "   ", 123, {}]) {
      const local = fakeClient([]);
      await captureStoreError(() => createMemoryV3DialogueStore(local.client).fail({
        runId: RUN_ID, userId: USER_ID, diagnosticCode: "unknown_failure", transportDetail: null,
        reconcilerRawResponse: null, reconcilerContext: bad as never,
      }));
      assert.equal(local.calls.length, 0);
    }
  });

  it("rejects unlisted failure diagnostics and malformed completion responses without retry", async () => {
    const local = fakeClient([]);
    await captureStoreError(() => createMemoryV3DialogueStore(local.client).fail({
      runId: RUN_ID, userId: USER_ID, diagnosticCode: "RAW_NOT_ALLOWLISTED" as never, transportDetail: null,
      reconcilerRawResponse: null, reconcilerContext: null,
    }));
    assert.equal(local.calls.length, 0);

    for (const response of [{ data: {}, error: null }, { data: null, error: { detail: RAW_SECRET } }, new Error(RAW_SECRET)]) {
      const fake = fakeClient([response]);
      await captureStoreError(() => createMemoryV3DialogueStore(fake.client).fail({
        runId: RUN_ID, userId: USER_ID, diagnosticCode: "unknown_failure", transportDetail: null,
        reconcilerRawResponse: null, reconcilerContext: null,
      }));
      assert.equal(fake.calls.length, 1);
    }
  });

  it("applies changed and unchanged state with exact sanitized audit arguments", async () => {
    for (const changed of [false, true]) {
      const expectedRevision = changed ? 1 : 0;
      const fake = fakeClient([{ data: [{ result: "succeeded", resulting_state_revision: expectedRevision }], error: null }]);
      const result = await createMemoryV3DialogueStore(fake.client).compareAndSwap(successWrite(changed));
      assert.deepEqual(result, { status: "succeeded", resultingStateRevision: expectedRevision });
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].name, "apply_memory_v3_dialogue_state");
      assert.deepEqual(Object.keys(fake.calls[0].args), [
        "p_run_id", "p_user_id", "p_conversation_id", "p_expected_state_revision", "p_state", "p_changed",
        "p_extraction", "p_operations", "p_transitions", "p_extractor_usage", "p_reconciler_usage",
      ]);
    }
  });

  it("writes a real create operation through with its topic, not just empty operations", async () => {
    // Regression coverage: every happy-path test above uses operations: [],
    // which never exercises projectOperations' per-item field check -- that's
    // exactly how a production-only bug (operations objects gained a `topic`
    // field for the topic-classification feature, but this store's own
    // independent field-shape check was never updated to expect it) shipped
    // without any test catching it. Every real write always failed here.
    // The same thing happened again for supersedesMemoryRef/Key (the
    // was->became linking feature): this fixture originally still had only
    // 4 keys, so this exact test stayed green while production's real
    // operations (5 keys, stamped by the reducer on every operation) failed
    // projectOperations' field-count check on every single write -- caught
    // only by a manual end-to-end test against the live canary account.
    const memoryKey = "a".repeat(64);
    const mentionTime = "2026-09-14T10:00:00.000Z";
    const extraction: MemoryV3Extraction = {
      run: emptyExtraction().run,
      items: [{
        localItemKey: memoryKey, kind: "event", claim: "Любит утренние прогулки",
        scope: "conversation", conversationId: CONVERSATION_ID,
        eventTimeStart: null, eventTimeEnd: null, status: "active",
        sensitivity: "normal", alternative: null,
      } as MemoryV3Extraction["items"][number]],
      evidence: [{
        itemKey: memoryKey, sourceMessageId: MESSAGE_ID, relation: "supports",
        supportType: null, episodeKey: "episode:1", provenanceRole: "user", mentionTime,
      } as MemoryV3Extraction["evidence"][number]],
    };
    const input = {
      ...successWrite(true),
      extraction,
      operations: [{ type: "create", candidateLocalItemKey: memoryKey, targetMemoryKey: null, topic: "person", supersedesMemoryKey: null }],
      transitions: [{ type: "create", candidateLocalItemKey: memoryKey, targetMemoryKey: null, resultingMemoryKey: memoryKey }],
      state: {
        ...emptyState(1),
        items: [{
          memoryKey, kind: "event", claim: "Любит утренние прогулки", status: "active",
          sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, alternative: null,
          topic: "person", firstSeenAt: mentionTime, updatedAt: mentionTime, revision: 1,
          replacesMemoryKey: null, replacedByMemoryKey: null,
          evidence: [{
            conversationId: CONVERSATION_ID, sourceMessageId: MESSAGE_ID, relation: "supports",
            supportType: null, episodeKey: "episode:1", provenanceRole: "user", mentionTime,
          }],
        }],
      },
    };
    const fake = fakeClient([{ data: [{ result: "succeeded", resulting_state_revision: 1 }], error: null }]);
    const result = await createMemoryV3DialogueStore(fake.client).compareAndSwap(input as never);
    assert.deepEqual(result, { status: "succeeded", resultingStateRevision: 1 });
    assert.equal(fake.calls.length, 1);
    const sentOperations = fake.calls[0].args.p_operations as Array<Record<string, unknown>>;
    assert.deepEqual(sentOperations, [
      { type: "create", candidateLocalItemKey: memoryKey, targetMemoryKey: null, topic: "person", supersedesMemoryKey: null },
    ]);
  });

  it("returns state_conflict only with a null resulting revision", async () => {
    const fake = fakeClient([{ data: [{ result: "state_conflict", resulting_state_revision: null }], error: null }]);
    assert.deepEqual(await createMemoryV3DialogueStore(fake.client).compareAndSwap(successWrite()), { status: "state_conflict" });
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
      await captureStoreError(() => createMemoryV3DialogueStore(fake.client).compareAndSwap(input as never));
      assert.equal(fake.calls.length, 0);
    }
    for (const response of [
      { data: [{ result: "succeeded", resulting_state_revision: 9 }], error: null },
      { data: [{ result: "state_conflict", resulting_state_revision: 0 }], error: null },
      { data: null, error: { detail: RAW_SECRET } },
      new Error(RAW_SECRET),
    ]) {
      const fake = fakeClient([response]);
      await captureStoreError(() => createMemoryV3DialogueStore(fake.client).compareAndSwap(successWrite()));
      assert.equal(fake.calls.length, 1);
    }
  });

  it("passes fresh JSON audit copies rather than caller-owned references", async () => {
    const input = successWrite();
    const fake = fakeClient([{ data: [{ result: "succeeded", resulting_state_revision: 0 }], error: null }]);
    await createMemoryV3DialogueStore(fake.client).compareAndSwap(input);
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
    await captureStoreError(() => createMemoryV3DialogueStore(local.client).reserve(input as never));
    assert.equal(getterCalls, 0);
    assert.equal(local.calls.length, 0);

    for (const response of [
      { data: [{ result: "reserved", run_id: RUN_ID, expected_state_revision: 0, state: { bad: true } }], error: null },
      { data: null, error: { message: RAW_SECRET } },
      new Error(RAW_SECRET),
    ]) {
      const fake = fakeClient([response]);
      await captureStoreError(() => createMemoryV3DialogueStore(fake.client).reserve(reservationInput()));
      assert.equal(fake.calls.length, 1);
    }
  });

  it("rejects revoked proxies and never trusts attacker-controlled property names", async () => {
    const revoked = Proxy.revocable(reservationInput(), {});
    revoked.revoke();
    const fake = fakeClient([]);
    await captureStoreError(() => createMemoryV3DialogueStore(fake.client).reserve(revoked.proxy));
    assert.equal(fake.calls.length, 0);

    const cyclic = successWrite() as Record<string, unknown>;
    cyclic.SUPER_SECRET_PROPERTY_NAME = cyclic;
    await captureStoreError(() => createMemoryV3DialogueStore(fake.client).compareAndSwap(cyclic as never));
    assert.equal(fake.calls.length, 0);
  });
});

function fakeTableClient(response: { data: unknown; error: unknown } | Error) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain = {
    select(...args: unknown[]) { calls.push({ method: "select", args }); return chain; },
    eq(...args: unknown[]) { calls.push({ method: "eq", args }); return chain; },
    order(...args: unknown[]) { calls.push({ method: "order", args }); return chain; },
    limit(...args: unknown[]) {
      calls.push({ method: "limit", args });
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    },
  };
  return {
    calls,
    client: {
      async rpc() { throw new Error("a cursor read must never call an RPC"); },
      from(table: string) { calls.push({ method: "from", args: [table] }); return chain; },
    },
  };
}

describe("Memory V3 dialogue store cursor lookup", () => {
  const cursorRow = {
    source_last_message_id: MESSAGE_ID,
    source_last_created_at: "2026-09-14T10:00:00.123456+00:00",
  };

  it("reads only succeeded runs of exactly this conversation, furthest source position first", async () => {
    // Ordering by source position (not completion time) means a run that
    // finishes late with an older window can never move the cursor back.
    const fake = fakeTableClient({ data: [cursorRow], error: null });
    assert.deepEqual(
      await createMemoryV3DialogueStore(fake.client).lastSucceededCursor({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      { messageId: MESSAGE_ID, createdAt: "2026-09-14T10:00:00.123456+00:00" },
    );
    assert.deepEqual(fake.calls, [
      { method: "from", args: ["memory_v3_dialogue_runs"] },
      { method: "select", args: ["source_last_message_id, source_last_created_at"] },
      { method: "eq", args: ["user_id", USER_ID] },
      { method: "eq", args: ["conversation_id", CONVERSATION_ID] },
      { method: "eq", args: ["status", "succeeded"] },
      { method: "order", args: ["source_last_created_at", { ascending: false }] },
      { method: "order", args: ["source_last_message_id", { ascending: false }] },
      { method: "limit", args: [1] },
    ]);
  });

  it("returns null when no run of this conversation has ever succeeded", async () => {
    const fake = fakeTableClient({ data: [], error: null });
    assert.equal(
      await createMemoryV3DialogueStore(fake.client).lastSucceededCursor({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      null,
    );
  });

  it("rejects malformed rows, extra columns, extra rows, and database errors with the generic store error", async () => {
    for (const response of [
      { data: null, error: { message: RAW_SECRET } },
      { data: [{ ...cursorRow, source_last_message_id: "not-a-uuid" }], error: null },
      { data: [{ ...cursorRow, source_last_created_at: "yesterday" }], error: null },
      { data: [{ ...cursorRow, extra: RAW_SECRET }], error: null },
      { data: [cursorRow, cursorRow], error: null },
      new Error(RAW_SECRET),
    ]) {
      const fake = fakeTableClient(response);
      await captureStoreError(() =>
        createMemoryV3DialogueStore(fake.client).lastSucceededCursor({ userId: USER_ID, conversationId: CONVERSATION_ID }));
    }
  });

  it("rejects invalid identifiers before any database access", async () => {
    for (const input of [
      { userId: "not-a-uuid", conversationId: CONVERSATION_ID },
      { userId: USER_ID, conversationId: "not-a-uuid" },
      { userId: USER_ID, conversationId: CONVERSATION_ID, extra: RAW_SECRET },
    ]) {
      const fake = fakeTableClient({ data: [], error: null });
      await captureStoreError(() => createMemoryV3DialogueStore(fake.client).lastSucceededCursor(input as never));
      assert.equal(fake.calls.length, 0);
    }
  });

  it("still constructs from an rpc-only client, and the cursor read then fails closed", async () => {
    const fake = fakeClient([]);
    const store = createMemoryV3DialogueStore(fake.client);
    await captureStoreError(() => store.lastSucceededCursor({ userId: USER_ID, conversationId: CONVERSATION_ID }));
    assert.equal(fake.calls.length, 0);
  });
});

describe("Memory V3 dialogue store recent consecutive failure count", () => {
  it("counts leading failed runs, newest first, stopping at the first non-failed run", async () => {
    const fake = fakeTableClient({
      data: [{ status: "failed" }, { status: "failed" }, { status: "succeeded" }, { status: "failed" }],
      error: null,
    });
    assert.equal(
      await createMemoryV3DialogueStore(fake.client).recentConsecutiveFailureCount({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      2,
    );
    assert.deepEqual(fake.calls, [
      { method: "from", args: ["memory_v3_dialogue_runs"] },
      { method: "select", args: ["status"] },
      { method: "eq", args: ["user_id", USER_ID] },
      { method: "eq", args: ["conversation_id", CONVERSATION_ID] },
      { method: "order", args: ["created_at", { ascending: false }] },
      { method: "order", args: ["id", { ascending: false }] },
      { method: "limit", args: [10] },
    ]);
  });

  it("returns 0 when the most recent run succeeded, is still reserved (in flight), or no run exists yet", async () => {
    for (const data of [[{ status: "succeeded" }], [{ status: "reserved" }], []]) {
      const fake = fakeTableClient({ data, error: null });
      assert.equal(
        await createMemoryV3DialogueStore(fake.client).recentConsecutiveFailureCount({ userId: USER_ID, conversationId: CONVERSATION_ID }),
        0,
      );
    }
  });

  it("counts every fetched run when all of them failed, without fetching further", async () => {
    const fake = fakeTableClient({ data: Array.from({ length: 10 }, () => ({ status: "failed" })), error: null });
    assert.equal(
      await createMemoryV3DialogueStore(fake.client).recentConsecutiveFailureCount({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      10,
    );
  });

  it("rejects malformed rows, extra columns, and database errors with the generic store error", async () => {
    for (const response of [
      { data: null, error: { message: RAW_SECRET } },
      { data: [{ status: "failed" }, { status: "bogus" }], error: null },
      { data: [{ status: "failed", extra: RAW_SECRET }], error: null },
      new Error(RAW_SECRET),
    ]) {
      const fake = fakeTableClient(response);
      await captureStoreError(() =>
        createMemoryV3DialogueStore(fake.client).recentConsecutiveFailureCount({ userId: USER_ID, conversationId: CONVERSATION_ID }));
    }
  });

  it("rejects invalid identifiers before any database access", async () => {
    for (const input of [
      { userId: "not-a-uuid", conversationId: CONVERSATION_ID },
      { userId: USER_ID, conversationId: "not-a-uuid" },
      { userId: USER_ID, conversationId: CONVERSATION_ID, extra: RAW_SECRET },
    ]) {
      const fake = fakeTableClient({ data: [], error: null });
      await captureStoreError(() => createMemoryV3DialogueStore(fake.client).recentConsecutiveFailureCount(input as never));
      assert.equal(fake.calls.length, 0);
    }
  });

  it("still constructs from an rpc-only client, and the count then fails closed", async () => {
    const fake = fakeClient([]);
    const store = createMemoryV3DialogueStore(fake.client);
    await captureStoreError(() => store.recentConsecutiveFailureCount({ userId: USER_ID, conversationId: CONVERSATION_ID }));
    assert.equal(fake.calls.length, 0);
  });
});
