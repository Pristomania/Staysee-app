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

  it("scopes every RPC call to the verified caller's own userId, never a client-supplied one", () => {
    const source = indexSource();
    assert.equal((source.match(/p_user_id:\s*userId/g) ?? []).length, 7);
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

  it("uses projectMemoryV3ExportItems (not the viewer projection) on both export branches", () => {
    const source = indexSource();
    assert.equal((source.match(/projectMemoryV3ExportItems\(/g) ?? []).length, 2);
  });

  it("never calls the all-conversations dialogue RPC without checking eligibility first", () => {
    const source = indexSource();
    const exportIndex = source.indexOf('body.action === "export"');
    const eligibilityIndex = source.indexOf("resolveMemoryV3DialogueEligibility", exportIndex);
    const dialogueAllIndex = source.indexOf("load_memory_v3_dialogue_viewer_items_all", exportIndex);
    assert.ok(exportIndex >= 0 && eligibilityIndex > exportIndex && eligibilityIndex < dialogueAllIndex);
  });

  it("export calls the all-conversations dialogue RPC, never the per-conversation one", () => {
    const source = indexSource();
    const exportIndex = source.indexOf('body.action === "export"');
    const readIndex = source.indexOf('action === "read" (default)');
    const exportBody = source.slice(exportIndex, readIndex);
    assert.doesNotMatch(exportBody, /"load_memory_v3_dialogue_viewer_items"/);
    assert.match(exportBody, /"load_memory_v3_dialogue_viewer_items_all"/);
  });

  it("fails loudly on an export RPC error instead of silently returning partial data", () => {
    const source = indexSource();
    const exportIndex = source.indexOf('body.action === "export"');
    const readIndex = source.indexOf('action === "read" (default)');
    const exportBody = source.slice(exportIndex, readIndex);
    assert.equal((exportBody.match(/error: "internal"/g) ?? []).length, 2);
  });

  it("tells the export caller when dialogue memory was omitted for eligibility reasons, instead of returning an indistinguishable empty array", () => {
    const source = indexSource();
    const exportIndex = source.indexOf('body.action === "export"');
    const readIndex = source.indexOf('action === "read" (default)');
    const exportBody = source.slice(exportIndex, readIndex);
    assert.match(exportBody, /dialogueAvailable/);
    const eligibilityIndex = exportBody.indexOf("eligibility.eligible");
    const availableAssignIndex = exportBody.indexOf("dialogueAvailable");
    const responseIndex = exportBody.lastIndexOf("accountWide, dialogue");
    assert.ok(eligibilityIndex >= 0 && availableAssignIndex >= 0 && responseIndex > availableAssignIndex);
    assert.match(exportBody, /dialogueAvailable[\s\S]*accountWide, dialogue, dialogueAvailable/);
  });
});
