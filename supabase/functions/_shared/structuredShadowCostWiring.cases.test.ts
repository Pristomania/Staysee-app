import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const chat = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8").split("\r\n").join("\n");
const usage = readFileSync(new URL("./usageAnalytics.ts", import.meta.url), "utf8");

describe("the structured shadow call is paid for, so its cost is recorded", () => {
  // Found on 30.10 by comparing the OpenRouter log line by line with our records: a GPT-4o call of 4,479 tokens in,
  // 189 out ($0.0131) appeared in the log with no record of ours. It was this audit-only second call, which runs after
  // the reply when STAYSEE_STRUCTURED_TURN is "shadow" and the sampling passes.
  const start = chat.indexOf("const shadowResult = await callModelStructured({");
  const end = chat.indexOf("} catch (shadowErr) {", start);
  const block = chat.slice(start, end);

  it("writes its usage under its own call kind, from the real figures of the call", () => {
    assert.ok(start > 0 && end > start, "the shadow call block is missing");
    assert.match(block, /logOpenRouterUsage\(/);
    assert.match(block, /callKind: "structured_turn_shadow"/);
    assert.match(block, /usage: shadowResult\.usage/);
    assert.match(block, /promptTokens: shadowResult\.promptTokens/);
    assert.match(block, /completionTokens: shadowResult\.completionTokens/);
    assert.match(usage, /\| "structured_turn_shadow"/);
  });

  it("does not let a failure to record turn into a failed audit", () => {
    assert.match(block, /EdgeRuntime\.waitUntil\(/);
  });
});
