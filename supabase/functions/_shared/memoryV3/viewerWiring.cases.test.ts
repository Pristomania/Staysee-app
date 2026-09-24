import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const INDEX_URL = new URL("../../memory-v3-viewer/index.ts", import.meta.url);

function indexSource(): string {
  return readFileSync(INDEX_URL, "utf8");
}

describe("memory-v3-viewer wiring", () => {
  it("verifies the caller's JWT before doing anything else", () => {
    const source = indexSource();
    assert.match(source, /resolveVerifiedChatUser/);
    const verifyIndex = source.indexOf("resolveVerifiedChatUser");
    const rpcIndex = source.indexOf(".rpc(");
    assert.ok(verifyIndex >= 0 && rpcIndex > verifyIndex, "must verify identity before any RPC call");
  });

  it("scopes both delete RPC calls to the verified caller's own userId, never a client-supplied one", () => {
    const source = indexSource();
    assert.equal((source.match(/p_user_id:\s*userId/g) ?? []).length, 5);
  });

  it("exposes delete_all for both Memory V3 scopes and rejects any other scope", () => {
    const source = indexSource();
    assert.match(source, /body\.action === "delete_all"/);
    assert.match(source, /delete_all_memory_v3_dialogue_data/);
    assert.match(source, /delete_all_memory_v3_lifecycle_data/);
    const deleteAllIndex = source.indexOf('body.action === "delete_all"');
    const scopeCheck = source.indexOf('scope !== "account_wide" && scope !== "dialogue"', deleteAllIndex);
    const invalidRequest = source.indexOf('error: "invalid_request"', deleteAllIndex);
    assert.ok(deleteAllIndex >= 0 && scopeCheck > deleteAllIndex && invalidRequest > scopeCheck);
  });

  it("never calls the dialogue read RPC without checking eligibility first", () => {
    const source = indexSource();
    const eligibilityIndex = source.indexOf("resolveMemoryV3DialogueEligibility");
    const dialogueLoadIndex = source.indexOf("load_memory_v3_dialogue_viewer_items");
    assert.ok(eligibilityIndex >= 0 && eligibilityIndex < dialogueLoadIndex);
  });

  it("never calls a dialogue delete without requiring a conversationId", () => {
    const source = indexSource();
    const dialogueScopeIndex = source.indexOf('body.scope === "dialogue"');
    const conversationCheckIndex = source.indexOf("conversationId", dialogueScopeIndex);
    const deleteCallIndex = source.indexOf("delete_memory_v3_dialogue_item");
    assert.ok(dialogueScopeIndex >= 0 && conversationCheckIndex > dialogueScopeIndex && conversationCheckIndex < deleteCallIndex);
  });

  it("filters out hypotheses on both read branches via projectMemoryV3ViewerItems", () => {
    const source = indexSource();
    assert.equal((source.match(/projectMemoryV3ViewerItems\(/g) ?? []).length, 2);
  });
});
