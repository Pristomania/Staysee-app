import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendPhotoBlocks,
  cleanDescription,
  IMAGE_DESCRIPTION_MAX_CHARS,
  imagesAllowedForUser,
  MAX_IMAGE_BASE64_CHARS,
  modelAcceptsImages,
  resolveImagesMode,
  validateImages,
  withImageParts,
} from "./imageAttachments.ts";

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
// The first bytes of each kind are what the check reads.
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const WEBP = b64([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

describe("image switch", () => {
  it("is off unless it says list or on", () => {
    assert.equal(resolveImagesMode(undefined), "off");
    assert.equal(resolveImagesMode(""), "off");
    assert.equal(resolveImagesMode("yes"), "off");
    assert.equal(resolveImagesMode(" LIST "), "list");
    assert.equal(resolveImagesMode("on"), "on");
  });

  it("lets only listed people in when the mode is list", () => {
    assert.equal(imagesAllowedForUser("off", "u1", "u1"), false);
    assert.equal(imagesAllowedForUser("on", "u1", undefined), true);
    assert.equal(imagesAllowedForUser("list", "u1", " u0 , u1 "), true);
    assert.equal(imagesAllowedForUser("list", "u2", "u0,u1"), false);
    assert.equal(imagesAllowedForUser("list", "u1", undefined), false);
    assert.equal(imagesAllowedForUser("list", "u1", ""), false);
  });
});

describe("validateImages", () => {
  it("accepts nothing, and one picture of each kind", () => {
    assert.deepEqual(validateImages(undefined), { ok: true, images: [] });
    assert.deepEqual(validateImages(null), { ok: true, images: [] });
    assert.deepEqual(validateImages([]), { ok: true, images: [] });
    const result = validateImages([
      { mime: "image/jpeg", data: JPEG },
      { mime: "image/png", data: PNG },
      { mime: "image/webp", data: WEBP },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.images.length, 3);
  });

  it("refuses what is not a list of at most three well-formed pictures", () => {
    const jpeg = { mime: "image/jpeg", data: JPEG };
    assert.deepEqual(validateImages("abc"), { ok: false, problem: "bad_data" });
    assert.deepEqual(validateImages([jpeg, jpeg, jpeg, jpeg]), { ok: false, problem: "too_many" });
    assert.deepEqual(validateImages([{ mime: "image/gif", data: JPEG }]), { ok: false, problem: "bad_type" });
    assert.deepEqual(validateImages([null]), { ok: false, problem: "bad_data" });
    assert.deepEqual(validateImages([{ mime: "image/jpeg" }]), { ok: false, problem: "bad_data" });
    assert.deepEqual(validateImages([{ mime: "image/jpeg", data: "not base64 !!" }]), { ok: false, problem: "bad_data" });
    assert.deepEqual(validateImages([{ mime: "image/jpeg", data: JPEG.slice(0, -1) }]), { ok: false, problem: "bad_data" });
  });

  it("refuses a picture whose bytes are not the kind it claims", () => {
    assert.deepEqual(validateImages([{ mime: "image/jpeg", data: PNG }]), { ok: false, problem: "bad_data" });
    assert.deepEqual(validateImages([{ mime: "image/png", data: btoa("this is plainly text, no image") }]), { ok: false, problem: "bad_data" });
  });

  it("refuses a picture above the size budget", () => {
    const huge = "A".repeat(MAX_IMAGE_BASE64_CHARS + 4);
    assert.deepEqual(validateImages([{ mime: "image/jpeg", data: huge }]), { ok: false, problem: "too_big" });
  });
});

describe("description lines", () => {
  it("puts one line per picture after the typed text, in a fixed format", () => {
    assert.equal(
      appendPhotoBlocks("Посмотри, пожалуйста", ["Лицо крупным планом, высыпания на лбу.", "Скриншот переписки."]),
      "Посмотри, пожалуйста\n\n[Фото 1: Лицо крупным планом, высыпания на лбу.]\n[Фото 2: Скриншот переписки.]",
    );
  });

  it("is just the lines when nothing was typed", () => {
    assert.equal(appendPhotoBlocks("", ["Закат над морем."]), "[Фото 1: Закат над морем.]");
    assert.equal(appendPhotoBlocks("  \n ", ["Закат."]), "[Фото 1: Закат.]");
  });

  it("keeps a description on one line without square brackets, and cuts it at a sentence", () => {
    assert.equal(cleanDescription("Первая строка.\n\nВторая [важная]   строка."), "Первая строка. Вторая (важная) строка.");
    const long = `${"Это предложение. ".repeat(60)}хвост без точки`;
    const cut = cleanDescription(long);
    assert.ok(cut.length <= IMAGE_DESCRIPTION_MAX_CHARS);
    assert.ok(cut.endsWith("."), cut.slice(-20));
  });
});

describe("vision parts", () => {
  const images = [{ mime: "image/jpeg" as const, data: JPEG }];

  it("turns only the last user message into text plus pictures", () => {
    const messages = [
      { role: "user", content: "старое" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "новое [Фото 1: …]" },
    ];
    const out = withImageParts(messages, images);
    assert.deepEqual(out[0], messages[0]);
    assert.deepEqual(out[1], messages[1]);
    assert.deepEqual(out[2], {
      role: "user",
      content: [
        { type: "text", text: "новое [Фото 1: …]" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${JPEG}` } },
      ],
    });
  });

  it("leaves the messages alone without pictures or without a user message", () => {
    const messages = [{ role: "assistant", content: "привет" }];
    assert.equal(withImageParts(messages, images), messages);
    const withUser = [{ role: "user", content: "x" }];
    assert.equal(withImageParts(withUser, []), withUser);
  });

  it("names the models that can look at pictures", () => {
    for (const model of ["openai/gpt-4o", "openai/gpt-4o-2024-08-06", "anthropic/claude-sonnet-4-5", "google/gemini-3.7-flash"]) {
      assert.equal(modelAcceptsImages(model), true, model);
    }
    for (const model of ["deepseek-chat", "mistral-large-latest", "gemini-1.5-pro", ""]) {
      assert.equal(modelAcceptsImages(model), false, model);
    }
  });
});
