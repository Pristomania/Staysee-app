import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { resolveMemoryV3LifecycleReadEligibility } from "./lifecycleReadMode.ts";
import { resolveMemoryV3ShadowEligibility } from "./mode.ts";

const INDEX_URL = new URL("../../staysee-chat/index.ts", import.meta.url);

function source(): string {
  return readFileSync(INDEX_URL, "utf8");
}

describe("Memory V3 full-product wiring", () => {
  it("selects isolated read and write state for multiple authenticated accounts", () => {
    for (const userId of [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ]) {
      assert.deepEqual(
        resolveMemoryV3LifecycleReadEligibility({
          rawMode: "all",
          rawAllowedUserId: undefined,
          userId,
        }),
        { mode: "all", eligible: true, userId },
      );
      assert.deepEqual(
        resolveMemoryV3ShadowEligibility({
          rawMode: "lifecycle_all",
          rawAllowedUserId: undefined,
          userId,
        }),
        { mode: "lifecycle_all", eligible: true, userId },
      );
    }
  });

  it("imports and schedules the privacy-safe Telegram alert boundary", () => {
    const text = source();
    assert.match(
      text,
      /import \{[\s\S]{0,260}sendMemoryV3TelegramAlertSafely[\s\S]{0,260}\} from "\.\.\/_shared\/memoryV3\/telegramAlert\.ts";/,
    );
    assert.match(
      text,
      /Deno\.env\.get\("STAYSEE_MEMORY_V3_ALERT_TELEGRAM_BOT_TOKEN"\)/,
    );
    assert.match(
      text,
      /Deno\.env\.get\("STAYSEE_MEMORY_V3_ALERT_TELEGRAM_CHAT_ID"\)/,
    );
    assert.match(
      text,
      /EdgeRuntime\.waitUntil\(\s*sendMemoryV3TelegramAlertSafely\(\{/,
    );
    assert.match(
      text,
      /\.rpc\(\s*"reserve_memory_v3_alert_window",\s*\{ p_alert_key: key \},\s*\)/,
    );
  });

  it("alerts only with closed path and diagnostic values", () => {
    const text = source();
    const helperStart = text.indexOf("function scheduleMemoryV3TelegramAlert(");
    const helperEnd = text.indexOf("// ── Model call with fallback", helperStart);
    assert.notEqual(helperStart, -1);
    assert.notEqual(helperEnd, -1);
    const helper = text.slice(helperStart, helperEnd);

    assert.match(helper, /path:\s*MemoryV3TelegramAlertPath/);
    assert.match(helper, /diagnosticCode:\s*MemoryV3TelegramAlertDiagnostic/);
    assert.match(helper, /path,\s*diagnosticCode,/);
    assert.doesNotMatch(
      helper,
      /userId|conversationId|message|claim|evidence|memoryItem/i,
    );
  });

  it("schedules read and write alerts only from failure diagnostics", () => {
    const text = source();
    const readStart = text.indexOf("function logMemoryV3LifecycleReadDiagnostic(");
    const readEnd = text.indexOf("// ── Model call with fallback", readStart);
    const readBlock = text.slice(readStart, readEnd);
    assert.match(readBlock, /scheduleMemoryV3TelegramAlert\("read", code\)/);

    const writeStart = text.indexOf("runMemoryV3LifecycleShadowBackgroundSafely(");
    const writeEnd = text.indexOf(': memoryV3Mode === "shadow"', writeStart);
    const writeBlock = text.slice(writeStart, writeEnd);
    assert.match(writeBlock, /scheduleMemoryV3TelegramAlert\("write", code\)/);
    assert.doesNotMatch(writeBlock, /daily_cap|duplicate/);
  });
});
