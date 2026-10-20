import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FULL_TEXT_ASSISTANT_REPLIES,
  LONG_MESSAGE_CHARS,
  MAX_MESSAGE_CHARS,
  buildLongMessageSummaryRequest,
  compactExpiredLongMessages,
  compactLongMessagesForModel,
  findExpiredLongMessageIds,
  formatCompactedContent,
  isMessageTooLong,
  parseLongMessageSummaryResponse,
} from "./longMessages.ts";

type Row = { id?: string; role: "user" | "assistant"; content: string };

const longText = (n = LONG_MESSAGE_CHARS + 1) => "а".repeat(n);
const user = (id: string, content: string): Row => ({ id, role: "user", content });
const assistant = (content = "Я рядом."): Row => ({ role: "assistant", content });
const replies = (count: number): Row[] => Array.from({ length: count }, () => assistant());

describe("limits", () => {
  it("are 10,000 characters per message, a long message starts above 4,000, and a long message is read in full for 10 replies", () => {
    assert.equal(MAX_MESSAGE_CHARS, 10_000);
    assert.equal(LONG_MESSAGE_CHARS, 4_000);
    assert.equal(FULL_TEXT_ASSISTANT_REPLIES, 10);
  });

  it("refuses only what is above the maximum", () => {
    assert.equal(isMessageTooLong("а".repeat(10_000)), false);
    assert.equal(isMessageTooLong("а".repeat(10_001)), true);
    assert.equal(isMessageTooLong(""), false);
  });
});

describe("which long messages are replaced by a short version", () => {
  it("keeps a long message in full for the 10 replies that follow it, then replaces it from the 11th reply on", () => {
    // The history a reply sees holds the assistant replies that already happened. Reply number k sees k-1 of them.
    for (let before = 0; before <= 9; before += 1) {
      const rows = [user("m1", longText()), ...replies(before)];
      assert.deepEqual(findExpiredLongMessageIds(rows), [], `reply ${before + 1} still reads it in full`);
    }
    const rows = [user("m1", longText()), ...replies(10)];
    assert.deepEqual(findExpiredLongMessageIds(rows), ["m1"], "the 11th reply gets the short version");
  });

  it("never touches a message of 4,000 characters or less, however old", () => {
    const rows = [user("m1", longText(LONG_MESSAGE_CHARS)), ...replies(30)];
    assert.deepEqual(findExpiredLongMessageIds(rows), []);
  });

  it("never touches assistant messages, and skips a long message that has no id", () => {
    const rows: Row[] = [{ role: "assistant", content: longText() }, { role: "user", content: longText() }, ...replies(20)];
    assert.deepEqual(findExpiredLongMessageIds(rows), []);
  });

  it("counts the replies that come after each message separately", () => {
    const rows = [user("old", longText()), ...replies(11), user("fresh", longText()), ...replies(3)];
    assert.deepEqual(findExpiredLongMessageIds(rows), ["old"]);
  });
});

describe("replacing the text", () => {
  it("swaps only the expired messages for a labelled short version and leaves everything else as it was", () => {
    const original = longText();
    const rows: Row[] = [user("old", original), ...replies(10), user("short", "Привет"), assistant("Привет!")];
    const compacted = compactExpiredLongMessages(rows, new Map([["old", "Человек пишет о ссоре с дочерью."]]));
    assert.equal(compacted[0].content, formatCompactedContent("Человек пишет о ссоре с дочерью."));
    assert.notEqual(compacted[0].content, original);
    assert.deepEqual(compacted.slice(1), rows.slice(1));
    assert.equal(rows[0].content, original, "the input is not changed");
  });

  it("keeps the full text when no short version exists", () => {
    const rows: Row[] = [user("old", longText()), ...replies(10)];
    assert.deepEqual(compactExpiredLongMessages(rows, new Map()), rows);
  });

  it("labels the short version so the model cannot take it for the person's own words", () => {
    assert.match(formatCompactedContent("Человек пишет о ссоре."), /^\[Краткая версия длинного сообщения человека: Человек пишет о ссоре\.\]$/);
  });
});

describe("compactLongMessagesForModel", () => {
  const expiredRows = (): Row[] => [user("m1", longText()), ...replies(10)];

  it("returns the same rows untouched, without any lookup, when nothing has expired", async () => {
    const rows = [user("m1", longText()), ...replies(3)];
    const calls: string[] = [];
    const result = await compactLongMessagesForModel(rows, "u1", {
      loadSummaries: async () => { calls.push("load"); return new Map(); },
      summarize: async () => { calls.push("summarize"); return null; },
      saveSummary: async () => { calls.push("save"); },
    });
    assert.equal(result, rows);
    assert.deepEqual(calls, []);
  });

  it("uses a stored short version without calling the model again", async () => {
    const calls: string[] = [];
    const result = await compactLongMessagesForModel(expiredRows(), "u1", {
      loadSummaries: async () => new Map([["m1", "Сохранённая краткая версия."]]),
      summarize: async () => { calls.push("summarize"); return null; },
      saveSummary: async () => { calls.push("save"); },
    });
    assert.equal(result[0].content, formatCompactedContent("Сохранённая краткая версия."));
    assert.deepEqual(calls, []);
  });

  it("makes the short version once, saves it for next time, and uses it", async () => {
    const saved: Array<{ id: string; userId: string; summary: string }> = [];
    const summarized: string[] = [];
    const rows = expiredRows();
    const result = await compactLongMessagesForModel(rows, "u1", {
      loadSummaries: async () => new Map(),
      summarize: async (text) => { summarized.push(text); return { summary: "Новая краткая версия." }; },
      saveSummary: async (row) => { saved.push(row); },
    });
    assert.deepEqual(summarized, [rows[0].content]);
    assert.deepEqual(saved, [{ id: "m1", userId: "u1", summary: "Новая краткая версия." }]);
    assert.equal(result[0].content, formatCompactedContent("Новая краткая версия."));
  });

  it("keeps the full text, and does not fail the reply, when the short version cannot be made", async () => {
    const rows = expiredRows();
    for (const summarize of [async () => null, async () => { throw new Error("provider down"); }]) {
      const result = await compactLongMessagesForModel(rows, "u1", {
        loadSummaries: async () => new Map(),
        summarize,
        saveSummary: async () => {},
      });
      assert.deepEqual(result, rows);
    }
  });

  it("still uses a short version when saving it fails, and does not fail when the lookup fails", async () => {
    const rows = expiredRows();
    const saveFails = await compactLongMessagesForModel(rows, "u1", {
      loadSummaries: async () => new Map(),
      summarize: async () => ({ summary: "Краткая." }),
      saveSummary: async () => { throw new Error("database down"); },
    });
    assert.equal(saveFails[0].content, formatCompactedContent("Краткая."));
    const lookupFails = await compactLongMessagesForModel(rows, "u1", {
      loadSummaries: async () => { throw new Error("database down"); },
      summarize: async () => ({ summary: "Краткая." }),
      saveSummary: async () => {},
    });
    assert.equal(lookupFails[0].content, formatCompactedContent("Краткая."));
  });

  it("makes at most two new short versions in one reply, so one reply never waits on a pile of them", async () => {
    const rows: Row[] = [
      user("a", longText()), user("b", longText()), user("c", longText()), ...replies(12),
    ];
    const summarized: string[] = [];
    const result = await compactLongMessagesForModel(rows, "u1", {
      loadSummaries: async () => new Map(),
      summarize: async (text) => { summarized.push(text.slice(0, 1)); return { summary: "Краткая." }; },
      saveSummary: async () => {},
    });
    assert.equal(summarized.length, 2);
    const replaced = result.filter((row) => row.content.startsWith("[Краткая версия")).length;
    assert.equal(replaced, 2);
  });
});

describe("the request for a short version", () => {
  it("asks for a faithful short version without advice, softening or invention, and keeps who said what", () => {
    const request = buildLongMessageSummaryRequest("Мой текст");
    assert.equal(request.messages[request.messages.length - 1].content, "Мой текст");
    const system = request.messages[0].content;
    assert.match(system, /кто что (?:писал|говорил)/i);
    assert.match(system, /не (?:оценивай|советуй|смягчай)/i);
  });

  it("goes through the private route like the memory calls", () => {
    const request = buildLongMessageSummaryRequest("Мой текст");
    assert.equal(request.model, "google/gemini-3.7-flash");
    assert.deepEqual(request.provider, { allow_fallbacks: true, data_collection: "deny", zdr: true });
    assert.equal(request.stream, false);
    assert.ok(request.max_tokens >= 500 && request.max_tokens <= 1_000);
  });
});

describe("reading the answer for a short version", () => {
  const ok = (content: string, extra: Record<string, unknown> = {}) => ({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 3_000, completion_tokens: 220, cost: 0.0013 },
    ...extra,
  });

  it("returns the trimmed text with the usage", () => {
    assert.deepEqual(parseLongMessageSummaryResponse(ok("  Человек пишет о ссоре.  ")), {
      summary: "Человек пишет о ссоре.",
      usage: { promptTokens: 3_000, completionTokens: 220, costUsd: 0.0013 },
    });
  });

  it("rejects an empty, missing or non-text answer", () => {
    for (const body of [ok("   "), { choices: [] }, {}, null, "text", { choices: [{ finish_reason: "stop", message: { content: 5 } }] }]) {
      assert.equal(parseLongMessageSummaryResponse(body), null);
    }
  });

  it("cuts an answer that ran into the limit back to its last full sentence, and caps the length", () => {
    const body = ok("Первая мысль. Вторая мысль. Третья обор");
    body.choices[0].finish_reason = "length";
    assert.equal(parseLongMessageSummaryResponse(body)?.summary, "Первая мысль. Вторая мысль.");
    const huge = parseLongMessageSummaryResponse(ok(`${"Слово. ".repeat(600)}`));
    assert.ok((huge?.summary.length ?? 0) <= 1_500);
  });

  it("takes usage as missing, not as zero, when the provider sent none", () => {
    const body = { choices: [{ finish_reason: "stop", message: { content: "Кратко." } }] };
    assert.deepEqual(parseLongMessageSummaryResponse(body), { summary: "Кратко.", usage: null });
  });
});
