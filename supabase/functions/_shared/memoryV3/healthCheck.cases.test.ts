import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MEMORY_V3_HEALTH_ALERT_KEYS,
  authorizeMemoryV3HealthRequest,
  evaluateMemoryV3Health,
  runMemoryV3HealthCheck,
  sendMemoryV3HealthTelegram,
} from "./healthCheck.ts";

const pipeline = (succeeded: number, failed = 0, stuck = 0, failedByCode: Record<string, number> = {}) =>
  ({ succeeded, failed, stuck, failedByCode });

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  windowMinutes: 120,
  userMessages: 30,
  dialogue: pipeline(25),
  lifecycle: pipeline(5),
  ...overrides,
});

describe("Memory V3 health rules", () => {
  it("finds nothing wrong when runs mostly succeed", () => {
    assert.deepEqual(evaluateMemoryV3Health(snapshot()), []);
  });

  it("flags a pipeline where at least 3 runs and at least 30% of them failed", () => {
    const findings = evaluateMemoryV3Health(snapshot({
      dialogue: pipeline(7, 3, 0, { extractor_transport_failed: 2, state_write_failed: 1 }),
    }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].alertKey, "health:failure_rate");
    assert.match(findings[0].line, /диалоговая/);
    assert.match(findings[0].line, /3 из 10/);
    assert.match(findings[0].line, /extractor_transport_failed \(2\)/);
  });

  it("does not flag too few failures, even when every run failed", () => {
    assert.deepEqual(evaluateMemoryV3Health(snapshot({ dialogue: pipeline(0, 2, 0, { state_write_failed: 2 }) })), []);
  });

  it("does not flag a low failure share, even with many failures", () => {
    assert.deepEqual(evaluateMemoryV3Health(snapshot({ dialogue: pipeline(70, 10, 0, { state_write_failed: 10 }) })), []);
  });

  it("counts runs stuck in 'reserved' as failures", () => {
    const findings = evaluateMemoryV3Health(snapshot({ lifecycle: pipeline(2, 0, 4) }));
    assert.equal(findings.length, 1);
    assert.match(findings[0].line, /сквозная/);
    assert.match(findings[0].line, /4 из 6/);
  });

  it("flags both pipelines separately under one alert key", () => {
    const findings = evaluateMemoryV3Health(snapshot({ dialogue: pipeline(1, 5), lifecycle: pipeline(1, 5) }));
    assert.deepEqual(findings.map((f) => f.alertKey), ["health:failure_rate", "health:failure_rate"]);
  });

  it("flags a silent pipeline: plenty of user messages, no dialogue runs at all", () => {
    const findings = evaluateMemoryV3Health(snapshot({ userMessages: 25, dialogue: pipeline(0) }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].alertKey, "health:silent");
    assert.match(findings[0].line, /25/);
  });

  it("does not call a quiet period silent", () => {
    assert.deepEqual(evaluateMemoryV3Health(snapshot({ userMessages: 5, dialogue: pipeline(0), lifecycle: pipeline(0) })), []);
  });

  it("does not call it silent when the dialogue pipeline ran, even if it failed", () => {
    const findings = evaluateMemoryV3Health(snapshot({ userMessages: 25, dialogue: pipeline(0, 1) }));
    assert.equal(findings.some((f) => f.alertKey === "health:silent"), false);
  });

  it("rejects a snapshot it cannot trust instead of reporting 'all fine'", () => {
    for (const bad of [
      null, "x", {}, snapshot({ userMessages: -1 }), snapshot({ dialogue: null }),
      snapshot({ dialogue: { succeeded: 1, failed: "2", stuck: 0, failedByCode: {} } }),
      snapshot({ lifecycle: pipeline(1, 1.5) }), snapshot({ windowMinutes: 0 }),
      snapshot({ dialogue: pipeline(1, 1, 0, { code: -3 }) }),
    ]) {
      assert.throws(() => evaluateMemoryV3Health(bad), /invalid health snapshot/);
    }
  });

  it("only uses alert keys the database accepts", () => {
    assert.deepEqual([...MEMORY_V3_HEALTH_ALERT_KEYS].sort(), ["health:failure_rate", "health:silent"]);
  });
});

describe("Memory V3 health request authorization", () => {
  const SECRET = "s3cret-value-for-tests-0123456789";

  it("accepts only the exact configured secret", () => {
    assert.equal(authorizeMemoryV3HealthRequest(SECRET, SECRET), "ok");
    assert.equal(authorizeMemoryV3HealthRequest(`  ${SECRET}\n`, SECRET), "ok", "surrounding whitespace is ignored on both sides");
  });

  it("rejects a missing, empty, wrong or look-alike secret", () => {
    for (const provided of [null, undefined, "", " ", "wrong", SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase()]) {
      assert.equal(authorizeMemoryV3HealthRequest(provided, SECRET), "unauthorized");
    }
  });

  it("refuses everything when no secret is configured, even an empty one", () => {
    for (const expected of [undefined, null, "", "   "]) {
      for (const provided of [SECRET, "", undefined]) {
        assert.equal(authorizeMemoryV3HealthRequest(provided, expected), "not_configured");
      }
    }
  });
});

describe("Memory V3 health check run", () => {
  const BOT = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const CHAT = "-1001234567890";

  function harness(snap: unknown, reserve: (key: string) => boolean = () => true) {
    const sent: string[] = [];
    const reserved: string[] = [];
    return {
      sent,
      reserved,
      deps: {
        loadSnapshot: async () => snap,
        reserveAlertKey: async (key: string) => { reserved.push(key); return reserve(key); },
        sendTelegram: async (text: string) => { sent.push(text); },
        now: () => new Date("2026-10-18T12:00:00Z"),
      },
    };
  }

  it("sends nothing and reserves nothing when healthy", async () => {
    const h = harness(snapshot());
    assert.deepEqual(await runMemoryV3HealthCheck(h.deps), { findings: [], alertsSent: [] });
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.reserved, []);
  });

  it("sends ONE message per alert key, combining both pipelines' lines", async () => {
    const h = harness(snapshot({ dialogue: pipeline(1, 5, 0, { state_write_failed: 5 }), lifecycle: pipeline(0, 4, 0, { extractor_transport_failed: 4 }) }));
    const result = await runMemoryV3HealthCheck(h.deps);
    assert.deepEqual(result.alertsSent, ["health:failure_rate"]);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0], /диалоговая/);
    assert.match(h.sent[0], /сквозная/);
    assert.match(h.sent[0], /2026-10-18T12:00:00/);
  });

  it("stays quiet for a key already alerted this hour", async () => {
    const h = harness(snapshot({ dialogue: pipeline(1, 5) }), () => false);
    const result = await runMemoryV3HealthCheck(h.deps);
    assert.deepEqual(result.findings, ["health:failure_rate"]);
    assert.deepEqual(result.alertsSent, []);
    assert.deepEqual(h.sent, []);
  });

  it("a dry run reports findings but reserves and sends nothing", async () => {
    const h = harness(snapshot({ dialogue: pipeline(1, 5) }));
    const result = await runMemoryV3HealthCheck({ ...h.deps, dryRun: true });
    assert.deepEqual(result, { findings: ["health:failure_rate"], alertsSent: [] });
    assert.deepEqual(h.reserved, []);
    assert.deepEqual(h.sent, []);
  });

  it("a connectivity test sends one clearly labelled message and touches neither the database nor an alert key", async () => {
    // Even with a broken snapshot: the test only proves that Telegram is reachable.
    const h = harness(snapshot({ dialogue: pipeline(1, 5) }));
    let loaded = false;
    const result = await runMemoryV3HealthCheck({
      ...h.deps, test: true, loadSnapshot: async () => { loaded = true; return {}; },
    });
    assert.deepEqual(result, { findings: [], alertsSent: ["test"] });
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0], /проверка связи/i);
    assert.deepEqual(h.reserved, []);
    assert.equal(loaded, false);
  });

  it("fails loudly when the snapshot cannot be loaded", async () => {
    const h = harness(snapshot());
    await assert.rejects(runMemoryV3HealthCheck({ ...h.deps, loadSnapshot: async () => { throw new Error("db down"); } }), /db down/);
  });

  it("fails loudly when an alert cannot be delivered", async () => {
    const h = harness(snapshot({ dialogue: pipeline(1, 5) }));
    await assert.rejects(
      runMemoryV3HealthCheck({ ...h.deps, sendTelegram: async () => { throw new Error("telegram 500"); } }),
      /telegram 500/,
    );
  });

  it("never puts identifiers or message text in an alert", async () => {
    const h = harness(snapshot({ dialogue: pipeline(1, 5, 0, { state_write_failed: 5 }) }));
    await runMemoryV3HealthCheck(h.deps);
    assert.doesNotMatch(h.sent[0], /[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  describe("Telegram delivery", () => {
    const ok = async () => ({ ok: true });

    it("posts the text to the bot API and succeeds on an ok response", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      await sendMemoryV3HealthTelegram({
        botToken: BOT, chatId: CHAT, text: "hello",
        fetchImpl: async (url, init) => { calls.push({ url, body: init.body }); return { ok: true }; },
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `https://api.telegram.org/bot${BOT}/sendMessage`);
      assert.deepEqual(JSON.parse(calls[0].body), { chat_id: CHAT, text: "hello" });
    });

    it("fails loudly when Telegram is not configured or the token/chat look wrong", async () => {
      for (const [botToken, chatId] of [[undefined, CHAT], [BOT, undefined], ["nope", CHAT], [BOT, "abc"]] as const) {
        await assert.rejects(
          sendMemoryV3HealthTelegram({ botToken, chatId, text: "x", fetchImpl: ok }),
          /telegram is not configured/,
        );
      }
    });

    it("fails loudly on a non-ok response, without leaking the token", async () => {
      await assert.rejects(
        sendMemoryV3HealthTelegram({ botToken: BOT, chatId: CHAT, text: "x", fetchImpl: async () => ({ ok: false, status: 401 }) }),
        (error: Error) => /telegram responded 401/.test(error.message) && !error.message.includes(BOT),
      );
    });
  });
});
