import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const screen = await readFile(
  new URL("../../../../src/components/screens/MemoryScreen.tsx", import.meta.url),
  "utf8",
);

describe("MemoryScreen legacy visibility", () => {
  it("uses an explicit profile capability instead of account age", () => {
    assert.match(screen, /isLegacyMemoryCompatibilityEnabled\(profile\)/u);
    assert.doesNotMatch(screen, /MEMORY_V3_VIEWER_LAUNCH_CUTOFF|user\.created_at/u);
  });

  it("does not query or render legacy memory without compatibility", () => {
    assert.match(
      screen,
      /capabilities\.showAccountWideMemory && showLegacyCompatibility/u,
    );
    assert.match(screen, /showLegacyCompatibility && \(\s*<details/gu);
    assert.match(screen, /Старая память беседы — для сравнения/u);
    assert.match(screen, /Старая сквозная память — для сравнения/u);
  });

  it("presents Memory V3 as the primary dialogue and account-wide lists", () => {
    const dialogueList = screen.indexOf("items={memoryV3Dialogue}");
    const legacyDialogue = screen.indexOf("Старая память беседы — для сравнения");
    const accountList = screen.indexOf("items={memoryV3AccountWide}");
    const legacyAccount = screen.indexOf("Старая сквозная память — для сравнения");
    assert.ok(dialogueList >= 0 && dialogueList < legacyDialogue);
    assert.ok(accountList >= 0 && accountList < legacyAccount);
  });

  it("shows the active conversation setting in the chat status badge", () => {
    assert.match(
      screen,
      /memoryReturnScreen === 'chat'\s*\? conversationCrossMemoryOn\s*:\s*crossMemoryOn/u,
    );
  });
});
