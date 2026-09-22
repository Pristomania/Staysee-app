import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const README_URL = new URL(
  "../../../../scripts/memory-v3-pilot/README.md",
  import.meta.url,
);

function rolloutSection(): string {
  const text = readFileSync(README_URL, "utf8");
  const start = text.indexOf("## Memory V3 full-product rollout");
  assert.notEqual(start, -1);
  const next = text.indexOf("\n## ", start + 4);
  return text.slice(start, next === -1 ? text.length : next);
}

describe("Memory V3 full-product rollout documentation", () => {
  it("documents exact all-account activation and bounded cost", () => {
    const text = rolloutSection();
    assert.match(text, /STAYSEE_MEMORY_V3_MODE=lifecycle_all/);
    assert.match(text, /STAYSEE_MEMORY_V3_LIFECYCLE_READ_MODE=all/);
    assert.match(text, /one lifecycle reservation per\s+authenticated account per UTC day/i);
    assert.match(text, /at most two sequential provider calls/i);
    assert.match(text, /no retry/i);
  });

  it("documents fallback and authoritative-empty behavior", () => {
    const text = rolloutSection();
    assert.match(text, /missing lifecycle head[^.]*legacy memory/i);
    assert.match(text, /authoritative empty[^.]*suppress[^.]*legacy/i);
    assert.match(text, /read or write failure[^.]*reply[^.]*continues/i);
  });

  it("documents Telegram privacy, deduplication, and secret names", () => {
    const text = rolloutSection();
    assert.match(text, /STAYSEE_MEMORY_V3_ALERT_TELEGRAM_BOT_TOKEN/);
    assert.match(text, /STAYSEE_MEMORY_V3_ALERT_TELEGRAM_CHAT_ID/);
    assert.match(text, /once per\s+exact path and diagnostic per UTC hour/i);
    assert.match(text, /no user ID, conversation ID, message, claim, evidence, memory content, raw error,\s+token, or chat ID/i);
    assert.match(text, /alert failure[^.]*never[^.]*reply/i);
  });

  it("documents secondary-account proof, rollback, and paid boundary", () => {
    const text = rolloutSection();
    assert.match(text, /existing secondary account/i);
    assert.match(text, /STAYSEE_MEMORY_V3_MODE=lifecycle_shadow/);
    assert.match(text, /STAYSEE_MEMORY_V3_LIFECYCLE_READ_MODE=canary/);
    assert.match(text, /STAYSEE_MEMORY_V3_MODE=off/);
    assert.match(text, /STAYSEE_MEMORY_V3_LIFECYCLE_READ_MODE=off/);
    assert.match(text, /separate paid provider benchmark[^.]*not authorized/i);
  });
});
