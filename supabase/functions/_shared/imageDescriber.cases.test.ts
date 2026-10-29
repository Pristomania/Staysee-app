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

describe("why a description failed", () => {
  const usageBody = { prompt_tokens: 900, completion_tokens: 300, cost: 0.002 };

  it("says why by a short code, with the billed usage when there is one, never with the answer", async () => {
    const cases: Array<[() => Promise<Response>, string, boolean]> = [
      [async () => jsonResponse({ error: "boom" }, 400), "http_400", false],
      [async () => jsonResponse({ error: "no endpoints" }, 404), "http_404", false],
      [async () => new Response("not json", { status: 200 }), "bad_json", false],
      [async () => jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "" } }], usage: usageBody }), "empty", true],
      [async () => jsonResponse({ choices: [{ finish_reason: "length", message: { content: "обрыв" } }], usage: usageBody }), "cut_off", true],
      [async () => jsonResponse({ choices: [{ finish_reason: "content_filter", message: { content: "" } }], usage: usageBody }), "finish_content_filter", true],
      [async () => jsonResponse({ choices: [] }), "unusable", false],
    ];
    for (const [attempt, code, billed] of cases) {
      const seen: Array<[string, unknown]> = [];
      const describe = createImageDescriber({
        apiKey: "k",
        fetchImpl: async () => attempt(),
        onFailure: (failure, usage) => { seen.push([failure, usage]); },
      });
      assert.equal(await describe(image), null);
      assert.ok(seen.length >= 1 && seen.every(([failure]) => failure === code), `${code}: ${JSON.stringify(seen)}`);
      assert.deepEqual(seen[0][1], billed ? { promptTokens: 900, completionTokens: 300, costUsd: 0.002 } : null, code);
    }
  });

  it("says no_key, network and timeout", async () => {
    const seen: string[] = [];
    const record = (failure: string) => { seen.push(failure); };
    await createImageDescriber({ apiKey: "", fetchImpl: async () => { throw new Error("must not be called"); }, onFailure: record })(image);
    await createImageDescriber({ apiKey: "k", fetchImpl: async () => { throw new Error("down"); }, onFailure: record })(image);
    await createImageDescriber({
      apiKey: "k",
      timeoutMs: 20,
      onFailure: record,
      fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    })(image);
    assert.deepEqual([seen[0], seen[seen.length - 1]], ["no_key", "timeout"]);
    assert.ok(seen.slice(1, -1).every((failure) => failure === "network"), JSON.stringify(seen));
  });

  it("tries once more after a failure that may pass, and not after one that will not", async () => {
    let calls = 0;
    const seen: string[] = [];
    const flaky = createImageDescriber({
      apiKey: "k",
      onFailure: (failure) => { seen.push(failure); },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "" } }] })
          : jsonResponse(okBody("Пейзаж: море и холм."));
      },
    });
    const result = await flaky(image);
    assert.equal(result?.description, "Пейзаж: море и холм.");
    assert.equal(calls, 2);
    assert.deepEqual(seen, ["empty"], "the failed first try is still reported");

    for (const [response, expectedCalls] of [
      [jsonResponse({ error: "bad request" }, 400), 1],
      [jsonResponse({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] }), 1],
      [jsonResponse({ error: "busy" }, 503), 2],
    ] as const) {
      let made = 0;
      const describe = createImageDescriber({ apiKey: "k", fetchImpl: async () => { made += 1; return response.clone(); } });
      assert.equal(await describe(image), null);
      assert.equal(made, expectedCalls);
    }
  });

  it("does not let a failing report break the description", async () => {
    const describe = createImageDescriber({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: "x" }, 400),
      onFailure: () => { throw new Error("report failed"); },
    });
    assert.equal(await describe(image), null);
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
