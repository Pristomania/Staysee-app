import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const chat = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8").split("\r\n").join("\n");
const usage = readFileSync(new URL("./usageAnalytics.ts", import.meta.url), "utf8");

const handlerStart = chat.indexOf("Deno.serve(");

describe("pictures are wired into the chat function", () => {
  it("accepts a message with no text when pictures come with it, and nothing else without text", () => {
    assert.match(chat, /images\?: unknown;/);
    assert.match(chat, /message: typedMessage,/);
    assert.match(chat, /let message = typedMessage;/);
    const required = chat.indexOf('error: "message is required"');
    assert.ok(required > handlerStart);
    assert.match(chat.slice(required - 500, required), /hasImages/);
  });

  it("does the picture step after the rate limit and before every safety check, as the first thing", () => {
    const rate = chat.indexOf("const rateLimitResult = await checkRateLimit");
    const disabled = chat.indexOf('unprocessable("images_disabled")');
    const validate = chat.indexOf("validateImages(body.images)");
    const daily = chat.indexOf('unprocessable("images_daily_limit")');
    const describe = chat.indexOf("describeImages(");
    const append = chat.indexOf("message = appendPhotoBlocks(typedMessage");
    const safety = chat.indexOf("let safety = evaluateTurnSafety(message");
    assert.ok(rate > 0 && rate < disabled, "the switch is checked after the rate limit");
    assert.ok(disabled < validate && validate < daily && daily < describe && describe < append, "order of the picture step");
    assert.ok(append < safety, "safety checks read the text with the description lines");
  });

  it("refuses when the switch is off, the count cannot be read, or a description fails", () => {
    assert.match(chat, /imagesAllowedForUser\(\s*resolveImagesMode\(Deno\.env\.get\("STAYSEE_IMAGE_ATTACHMENTS"\)\)/);
    assert.match(chat, /unprocessable\("images_unavailable"\)/);
    assert.match(chat, /unprocessable\("image_unreadable"\)/);
    assert.match(chat, /status: 422/);
  });

  it("records every paid description call, under its own kind, even when the batch failed", () => {
    const logging = chat.indexOf("for (const paid of described.paid)");
    assert.ok(logging > 0 && logging < chat.indexOf('unprocessable("image_unreadable")'));
    assert.match(chat.slice(logging, logging + 700), /callKind: IMAGE_CALL_KIND/);
    assert.match(usage, /\| "image_description"/);
  });

  it("gives the pictures to the main call only, and sends back the text that was used", () => {
    assert.match(chat, /withImageParts\(messages, images\)/);
    assert.match(chat, /images\.length > 0 && modelAcceptsImages\(model\)/);
    const main = chat.indexOf("let result = await callModel(");
    assert.match(chat.slice(main, main + 400), /turnImages/);
    const retry = chat.indexOf("const retry = await callModel(");
    assert.doesNotMatch(chat.slice(retry, retry + 400), /turnImages/);
    assert.match(chat, /\.\.\.\(turnImages\.length > 0 \? \{ userText: message \} : \{\}\)/);
  });

  it("never writes a picture or a description into the log", () => {
    const logLines = chat.split("\n").filter((line) => /console\.(log|warn|error|info)\(/.test(line));
    for (const line of logLines) {
      assert.doesNotMatch(line, /turnImages|described|descriptions|data:image|typedMessage/, line);
    }
  });
});
