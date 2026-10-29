import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { costWindow, formatCostTable, MAX_PICTURE_BASE64_CHARS, pictureFromBytes } from "./image-live-check.mjs";

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1];
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52];

describe("pictureFromBytes", () => {
  it("names the kind from the first bytes and returns the base64 text", () => {
    const jpeg = pictureFromBytes("a.jpg", Uint8Array.from(JPEG_HEAD));
    assert.equal(jpeg.mime, "image/jpeg");
    assert.equal(jpeg.data, Buffer.from(JPEG_HEAD).toString("base64"));
    assert.equal(pictureFromBytes("b.png", Uint8Array.from(PNG_HEAD)).mime, "image/png");
  });

  it("refuses what is not a picture, and a picture above the server's budget", () => {
    assert.throws(() => pictureFromBytes("c.txt", Buffer.from("just text, not a picture at all")), /not a JPEG, PNG or WebP/);
    const big = new Uint8Array(Math.ceil((MAX_PICTURE_BASE64_CHARS / 4) * 3) + 12);
    big.set(JPEG_HEAD);
    assert.throws(() => pictureFromBytes("d.jpg", big), /too big/);
  });
});

describe("cost table", () => {
  const rows = [
    { created_at: "2026-10-29T09:31:05.123Z", call_kind: "image_description", model: "google/gemini-3.7-flash", prompt_tokens: 800, completion_tokens: 120, cost: 0.0009 },
    { created_at: "2026-10-29T09:31:09.000Z", call_kind: null, model: "openai/gpt-4o", prompt_tokens: 5200, completion_tokens: 310, cost: 0.0171 },
  ];

  it("lists one line per call and the sum", () => {
    const table = formatCostTable(rows);
    assert.match(table, /09:31:05/);
    assert.match(table, /image_description/);
    assert.match(table, /chat/);
    assert.match(table, /0\.001800|0\.0180/);
    const total = table.split("\n").find((line) => line.startsWith("TOTAL"));
    assert.ok(total, "a TOTAL line");
    assert.match(total, /0\.018000/);
  });

  it("says plainly when there are no rows", () => {
    assert.match(formatCostTable([]), /no calls recorded/i);
  });

  it("gives the window to look at in the OpenRouter dashboard, in UTC and local time", () => {
    const text = costWindow(Date.UTC(2026, 9, 29, 9, 30, 0), Date.UTC(2026, 9, 29, 9, 36, 30));
    assert.match(text, /09:30:00/);
    assert.match(text, /09:36:30/);
    assert.match(text, /UTC/);
  });
});
