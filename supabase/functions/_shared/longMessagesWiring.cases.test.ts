import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const chat = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8");
const context = readFileSync(new URL("./context.ts", import.meta.url), "utf8");

describe("long messages are wired into the chat function", () => {
  it("refuses a message above the maximum before any model, memory or database work", () => {
    const check = chat.indexOf("isMessageTooLong(message)");
    assert.ok(check > 0, "the length check is missing");
    assert.match(chat.slice(check, check + 400), /message_too_long/);
    assert.match(chat.slice(check, check + 400), /status: 400/);
    // After the "message is required" check, before the provider is even looked up.
    assert.ok(chat.indexOf('error: "message is required"') < check);
    assert.ok(check < chat.indexOf("const providerKey"), "the check must come before the provider lookup");
  });

  it("replaces expired long messages in the history the model reads, behind an off switch", () => {
    assert.match(chat, /Deno\.env\.get\("STAYSEE_LONG_MESSAGE_COMPACTION"\) !== "off"/);
    assert.match(chat, /compactLongMessagesForModel\(\s*packet\.recentMessages/);
    assert.match(chat, /createLongMessageStore\(/);
    assert.match(chat, /createLongMessageSummarizer\(/);
  });

  it("logs the cost of making a short version", () => {
    assert.match(chat, /callKind: "long_message_summary"/);
  });

  it("reads message ids with the recent history, which the replacement needs", () => {
    assert.match(context, /\.select\("id, sender, role, content, created_at"\)/);
  });
});
