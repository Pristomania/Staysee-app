import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MEMORY_V3_RETRY_DELAY_MS,
  runWithOneConflictRetry,
  withOneTransientRetry,
} from "./retry.ts";

const sleeper = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
};

const diagnosticOf = (error: unknown) => (error as { diagnostic?: string }).diagnostic ?? null;
const failure = (diagnostic: string) => Object.assign(new Error(diagnostic), { diagnostic });

describe("how long to wait before the second attempt", () => {
  it("waits 10 seconds: long enough for a rate limit or a provider hiccup to pass, short enough to finish the run", () => {
    assert.equal(MEMORY_V3_RETRY_DELAY_MS, 10_000);
  });
});

describe("one retry for a transient model call failure", () => {
  it("calls once and does not wait when the first call works", async () => {
    const s = sleeper();
    let calls = 0;
    const wrapped = withOneTransientRetry(async (input: string) => { calls += 1; return `ok:${input}`; }, diagnosticOf, s);
    assert.equal(await wrapped("x"), "ok:x");
    assert.equal(calls, 1);
    assert.deepEqual(s.waits, []);
  });

  it("retries once after a transient failure and returns the retry's result", async () => {
    const s = sleeper();
    let calls = 0;
    const wrapped = withOneTransientRetry(async () => {
      calls += 1;
      if (calls === 1) throw failure("provider_http_5xx");
      return "recovered";
    }, diagnosticOf, s);
    assert.equal(await wrapped(), "recovered");
    assert.equal(calls, 2);
    assert.deepEqual(s.waits, [MEMORY_V3_RETRY_DELAY_MS]);
  });

  it("passes the same request to the retry", async () => {
    const seen: unknown[] = [];
    let calls = 0;
    const wrapped = withOneTransientRetry(async (request: { id: number }) => {
      seen.push(request);
      calls += 1;
      if (calls === 1) throw failure("transport_timeout");
      return "ok";
    }, diagnosticOf, sleeper());
    const request = { id: 7 };
    await wrapped(request);
    assert.deepEqual(seen, [request, request]);
  });

  it("gives up after the second failure and reports the SECOND error", async () => {
    let calls = 0;
    const wrapped = withOneTransientRetry(async () => {
      calls += 1;
      throw failure(calls === 1 ? "transport_failed" : "transport_timeout");
    }, diagnosticOf, sleeper());
    await assert.rejects(wrapped(), (error: Error) => error.message === "transport_timeout");
    assert.equal(calls, 2, "never a third call");
  });

  it("retries each transient kind: connection, timeout, provider 5xx and 4xx (rate limits)", async () => {
    for (const diagnostic of ["transport_failed", "transport_timeout", "provider_http_5xx", "provider_http_4xx"]) {
      let calls = 0;
      const wrapped = withOneTransientRetry(async () => {
        calls += 1;
        if (calls === 1) throw failure(diagnostic);
        return "ok";
      }, diagnosticOf, sleeper());
      assert.equal(await wrapped(), "ok", diagnostic);
      assert.equal(calls, 2, diagnostic);
    }
  });

  it("does not retry an answer that arrived but was unusable (it was already paid for) or an unknown error", async () => {
    for (const error of [failure("provider_response_invalid"), new Error("anything else"), failure("")]) {
      let calls = 0;
      const wrapped = withOneTransientRetry(async () => { calls += 1; throw error; }, diagnosticOf, sleeper());
      await assert.rejects(wrapped(), (caught: unknown) => caught === error);
      assert.equal(calls, 1);
    }
  });
});

type Result = { status: "succeeded" } | { status: "skipped"; reason: string } | { status: "failed"; diagnosticCode: string };

describe("one retry of a whole memory run after a write conflict", () => {
  it("runs once when it succeeds, is skipped, or fails for another reason", async () => {
    for (const result of [
      { status: "succeeded" }, { status: "skipped", reason: "duplicate" },
      { status: "failed", diagnosticCode: "extractor_contract_invalid" },
    ] as Result[]) {
      let calls = 0;
      const s = sleeper();
      const got = await runWithOneConflictRetry(async () => { calls += 1; return result; }, s);
      assert.deepEqual(got, result);
      assert.equal(calls, 1);
      assert.deepEqual(s.waits, []);
    }
  });

  it("runs again after a state_conflict and returns the second result", async () => {
    const results: Result[] = [{ status: "failed", diagnosticCode: "state_conflict" }, { status: "succeeded" }];
    let calls = 0;
    const s = sleeper();
    const got = await runWithOneConflictRetry(async () => results[calls++], s);
    assert.deepEqual(got, { status: "succeeded" });
    assert.equal(calls, 2);
    assert.deepEqual(s.waits, [MEMORY_V3_RETRY_DELAY_MS]);
  });

  it("returns the second failure when the conflict repeats, and never runs a third time", async () => {
    let calls = 0;
    const got = await runWithOneConflictRetry(
      async (): Promise<Result> => { calls += 1; return { status: "failed", diagnosticCode: "state_conflict" }; },
      sleeper(),
    );
    assert.deepEqual(got, { status: "failed", diagnosticCode: "state_conflict" });
    assert.equal(calls, 2);
  });

  it("lets an error thrown by the run propagate without retrying", async () => {
    let calls = 0;
    await assert.rejects(
      runWithOneConflictRetry(async () => { calls += 1; throw new Error("boom"); }, sleeper()),
      /boom/,
    );
    assert.equal(calls, 1);
  });
});
