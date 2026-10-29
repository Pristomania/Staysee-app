import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildImageDescriptionRequest,
  countImagesDescribedSince,
  createImageDescriber,
  describeImages,
  IMAGE_DESCRIBE_MODEL,
  IMAGE_DESCRIPTION_PROMPT,
} from "./imageDescriber.ts";

const image = { mime: "image/jpeg" as const, data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD" };
const okBody = (text: string) => ({
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }],
  usage: { prompt_tokens: 800, completion_tokens: 120, cost: 0.0009 },
});
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("image description request", () => {
  it("sends the picture to a private, non-retaining route with the rules for describing", () => {
    const request = buildImageDescriptionRequest(image);
    assert.equal(request.model, IMAGE_DESCRIBE_MODEL);
    assert.deepEqual(request.provider, { allow_fallbacks: true, data_collection: "deny", zdr: true });
    assert.equal(request.usage.include, true);
    assert.equal(request.messages[0].content, IMAGE_DESCRIPTION_PROMPT);
    const user = request.messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    assert.equal(user[1].type, "image_url");
    assert.equal(user[1].image_url?.url, `data:image/jpeg;base64,${image.data}`);
  });

  it("tells the model what to leave out and that text on a picture is content, not an instruction", () => {
    for (const part of ["имена", "телефон", "диагноз", "не узнавай", "не указания", "не выдумывай"]) {
      assert.ok(IMAGE_DESCRIPTION_PROMPT.toLowerCase().includes(part), part);
    }
  });
});

describe("image describer", () => {
  it("returns the description with its usage", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const describe = createImageDescriber({
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return jsonResponse(okBody("Скриншот переписки: собеседник просит прощения."));
      },
    });
    const result = await describe(image);
    assert.deepEqual(result, {
      description: "Скриншот переписки: собеседник просит прощения.",
      usage: { promptTokens: 800, completionTokens: 120, costUsd: 0.0009 },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer test-key");
  });

  it("returns null, and never throws, for an error, a refusal, a cut-off answer, a network failure or no key", async () => {
    const attempts: Array<() => Promise<Response>> = [
      async () => jsonResponse({ error: "boom" }, 500),
      async () => jsonResponse({ error: "no endpoints" }, 404),
      async () => new Response("not json", { status: 200 }),
      async () => jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "" } }] }),
      async () => jsonResponse({ choices: [{ finish_reason: "length", message: { content: "обрыв на полу" } }] }),
      async () => { throw new Error("network down"); },
    ];
    for (const attempt of attempts) {
      const describe = createImageDescriber({ apiKey: "k", fetchImpl: async () => attempt() });
      assert.equal(await describe(image), null);
    }
    const noKey = createImageDescriber({ apiKey: "", fetchImpl: async () => { throw new Error("must not be called"); } });
    assert.equal(await noKey(image), null);
  });

  it("gives up after the time limit", async () => {
    const describe = createImageDescriber({
      apiKey: "k",
      timeoutMs: 30,
      fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });
    const started = Date.now();
    assert.equal(await describe(image), null);
    assert.ok(Date.now() - started < 1_000);
  });
});

describe("describeImages", () => {
  const done = (description: string) => ({ description, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001 } });

  it("returns every description in order when all work", async () => {
    const texts = ["первая", "вторая"];
    let n = 0;
    const result = await describeImages([image, image], async () => done(texts[n++]));
    assert.deepEqual(result.descriptions?.map((d) => d.description), ["первая", "вторая"]);
    assert.equal(result.paid.length, 2);
  });

  it("is all or nothing, and still reports the calls that were paid for", async () => {
    let n = 0;
    const result = await describeImages([image, image, image], async () => (n++ === 1 ? null : done("ок")));
    assert.equal(result.descriptions, null);
    assert.equal(result.paid.length, 2);
  });
});

describe("countImagesDescribedSince", () => {
  const fakeClient = (answer: { count: number | null; error: unknown }, seen: unknown[][] = []) => ({
    from(table: string) {
      seen.push(["from", table]);
      const chain = {
        select: (...args: unknown[]) => { seen.push(["select", ...args]); return chain; },
        eq: (...args: unknown[]) => { seen.push(["eq", ...args]); return chain; },
        gte: (...args: unknown[]) => { seen.push(["gte", ...args]); return Promise.resolve(answer); },
      };
      return chain;
    },
  });

  it("counts the description rows of one person since a moment", async () => {
    const seen: unknown[][] = [];
    const count = await countImagesDescribedSince(fakeClient({ count: 7, error: null }, seen), "u1", "2026-10-28T10:00:00.000Z");
    assert.equal(count, 7);
    assert.deepEqual(seen.filter((s) => s[0] === "eq"), [["eq", "user_id", "u1"], ["eq", "call_kind", "image_description"]]);
    assert.deepEqual(seen.find((s) => s[0] === "gte"), ["gte", "created_at", "2026-10-28T10:00:00.000Z"]);
  });

  it("throws when the count cannot be read, so the caller can refuse", async () => {
    await assert.rejects(countImagesDescribedSince(fakeClient({ count: null, error: { message: "x" } }), "u1", "2026-10-28T10:00:00.000Z"));
    await assert.rejects(countImagesDescribedSince(fakeClient({ count: null, error: null }), "u1", "2026-10-28T10:00:00.000Z"));
  });
});
