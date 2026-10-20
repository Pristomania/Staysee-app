import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const server = readFileSync(new URL("./longMessages.ts", import.meta.url), "utf8");
const limits = readFileSync(new URL("../../../src/lib/messageLimits.ts", import.meta.url), "utf8");
const screen = readFileSync(new URL("../../../src/components/screens/ChatScreen.tsx", import.meta.url), "utf8");

describe("the message length limit reaches the input box", () => {
  it("is the same number in the chat function and in the input box", () => {
    const fromServer = server.match(/export const MAX_MESSAGE_CHARS = ([\d_]+);/)?.[1];
    const fromScreen = limits.match(/export const MAX_MESSAGE_CHARS = ([\d_]+);/)?.[1];
    assert.ok(fromServer && fromScreen, "both constants must exist");
    assert.equal(fromServer, fromScreen);
  });

  it("measures the text in the input box", () => {
    assert.match(screen, /from '\.\.\/\.\.\/lib\/messageLimits'/);
    assert.match(screen, /messageLengthState\(inputValue\)/);
  });

  it("does not send a text that is too long, by button, Enter or voice", () => {
    const start = screen.indexOf("async function handleSend()");
    assert.ok(start > 0);
    assert.match(screen.slice(start, start + 700), /lengthState\.tooLong/);
    assert.match(screen, /disabled=\{!inputValue\.trim\(\) \|\| lengthState\.tooLong( \|\| fileReading)?\}/);
  });

  it("reports the length (never the text) once each time the box goes over the maximum", () => {
    assert.match(screen, /from '\.\.\/\.\.\/lib\/overLimitReport'/);
    assert.match(screen, /shouldReportOverLimit\(wasTooLongRef\.current, lengthState\.tooLong\)/);
    assert.match(screen, /reportOverLimit\(lengthState\.length\)/);
  });

  it("shows a line only for a text that is too long, and never a counter", () => {
    assert.match(screen, /messageLengthHint\(lengthState\)/);
    assert.match(screen, /role="status"/);
    assert.doesNotMatch(limits, /COUNTER_FROM_CHARS|showCounter/);
  });
});
