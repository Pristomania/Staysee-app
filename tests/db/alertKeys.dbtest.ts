import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { MEMORY_V3_HEALTH_ALERT_KEYS } from "../../supabase/functions/_shared/memoryV3/healthCheck.ts";
import { adminClient } from "./helpers.ts";

// The Telegram alert sender builds a key "<path>:<diagnostic>" and asks the
// database function reserve_memory_v3_alert_window (one alert per key per hour)
// whether to send. The function only accepts a closed list of keys. A key the
// code can produce but the database rejects makes that alert silently vanish
// (migration 079 added write:forced_skip for exactly this reason), so this
// reads the code's own list and checks every key against the real function.

const source = readFileSync(
  new URL("../../supabase/functions/_shared/memoryV3/telegramAlert.ts", import.meta.url),
  "utf8",
);

function diagnosticsOf(setName: string): string[] {
  const body = source.match(new RegExp(`const ${setName} = new Set<[^>]+>\\(\\[([\\s\\S]*?)\\]\\)`))?.[1];
  assert.ok(body, `${setName} not found in telegramAlert.ts -- update this test if it was renamed`);
  return [...body.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

const KEYS = [
  ...diagnosticsOf("READ_DIAGNOSTICS").map((code) => `read:${code}`),
  ...diagnosticsOf("WRITE_DIAGNOSTICS").map((code) => `write:${code}`),
  ...MEMORY_V3_HEALTH_ALERT_KEYS,
];

describe("Memory V3 alert keys on real Postgres", () => {
  let client: SupabaseClient;

  before(() => {
    client = adminClient();
  });

  it("finds the code's alert keys, including the forced-skip one", () => {
    assert.ok(KEYS.length >= 21, `expected the full list, got ${KEYS.length}`);
    assert.ok(KEYS.includes("write:forced_skip"));
    assert.ok(KEYS.includes("health:failure_rate") && KEYS.includes("health:silent"));
  });

  for (const key of KEYS) {
    it(`the database accepts the key the code can send: ${key}`, async () => {
      const { data, error } = await client.rpc("reserve_memory_v3_alert_window", { p_alert_key: key });
      assert.equal(error, null);
      assert.equal(typeof data, "boolean");
    });
  }

  it("sends at most one alert per key per hour", async () => {
    await client.rpc("reserve_memory_v3_alert_window", { p_alert_key: "write:forced_skip" });
    const { data, error } = await client.rpc("reserve_memory_v3_alert_window", { p_alert_key: "write:forced_skip" });
    assert.equal(error, null);
    assert.equal(data, false);
  });

  it("rejects a key that is not on the list", async () => {
    const { error } = await client.rpc("reserve_memory_v3_alert_window", { p_alert_key: "write:not_a_real_key" });
    assert.notEqual(error, null);
    assert.match(String(error?.message), /invalid memory v3 alert key/);
  });
});
