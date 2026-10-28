import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const screen = readFileSync(new URL("../../../src/components/screens/ChatScreen.tsx", import.meta.url), "utf8")
  .split("\r\n")
  .join("\n");

function bodyOf(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} is missing`);
  const end = source.indexOf("\n  }\n", start);
  assert.ok(end > start, `${header} has no end`);
  return source.slice(start, end);
}

describe("the 'Запомнила' line in the chat screen", () => {
  const send = bodyOf(screen, "async function handleSend()");

  it("no longer writes the sentence into the old, switched-off conversation summary", () => {
    assert.doesNotMatch(screen, /appendToConversationMemory/);
    assert.doesNotMatch(screen, /conversationMemoryCapture/);
    assert.equal(existsSync(new URL("../../../src/lib/conversationMemoryCapture.ts", import.meta.url)), false);
  });

  it("takes a snapshot of the new memory before the request goes out", () => {
    const branch = send.indexOf("userCapture?.action === 'dialog_memory'");
    assert.ok(branch > 0);
    const snapshot = send.indexOf("takeMemorySnapshot(convId)");
    assert.ok(snapshot > branch, "the snapshot belongs to the 'remember' branch");
    assert.ok(snapshot < send.indexOf("sendAiMessage("), "and is taken before the reply is asked for");
  });

  it("waits for the new memory only after the turn is saved, and shows the line only if something was really stored", () => {
    const saved = send.indexOf("persistedTurnRef.current = {");
    const wait = send.indexOf("waitForRememberedItem(");
    assert.ok(saved > 0 && wait > saved, "the wait starts after the turn is saved");
    const nudge = send.indexOf("kind: 'memory_saved'");
    assert.ok(nudge > wait, "the line comes after the wait");
    assert.match(send.slice(wait, nudge), /if \(!stored/);
    assert.equal(send.split("kind: 'memory_saved'").length - 1, 1, "and is shown from one place only");
  });

  it("does not show the line in another conversation", () => {
    const wait = send.indexOf("waitForRememberedItem(");
    assert.match(send.slice(wait, wait + 900), /openConversationRef\.current !== convId/);
  });
});
