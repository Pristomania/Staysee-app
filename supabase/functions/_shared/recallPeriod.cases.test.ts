import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { searchConversationArchive } from "./conversationRetrieval.ts";
import { RECALL_GATE_SYSTEM_PROMPT, askRecallGate, askRecallGateOpenRouter, parseRecallDecision, recallGateToday } from "./recallGate.ts";
import { RECALL_PERIOD_USER_NOTE, RECALL_USER_NOTE, buildRecallPeriodPrompt, withRecallUserNote } from "./recallGrounding.ts";

const TODAY = "2026-11-26";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the reserve of the small model gets whole answers", () => {
  it("keeps the private route and leaves out the host that cuts the end of the answer (live, 26.11.2026: 20 of 21 answers of Google came without the closing brackets)", async () => {
    const bodies: Array<{ provider: Record<string, unknown> }> = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"recall": false, "query": ""}' } }] }) };
    }) as never;
    await askRecallGateOpenRouter("привет", { apiKey: "k", fetchImpl });
    assert.deepEqual(bodies[0].provider, { data_collection: "deny", zdr: true, ignore: ["Google"] });
  });

  it("asks for the parts of a month and for «a month ago» as stretches, not single days", () => {
    assert.match(RECALL_GATE_SYSTEM_PROMPT, /в начале или в конце месяца/);
    assert.match(RECALL_GATE_SYSTEM_PROMPT, /по неделе в обе стороны/);
  });
});

describe("the small model also tells which time the person asks about", () => {
  const parse = (extra: string, recall = true) => parseRecallDecision(`{"recall": ${recall}, "query": "моё состояние", ${extra}}`, TODAY);

  it("reads the first and the last day of the named time", () => {
    assert.deepEqual(parse('"from": "2026-06-01", "to": "2026-06-30"')?.period, { from: "2026-06-01", to: "2026-06-30" });
    assert.deepEqual(parse('"from": "2026-06-14", "to": "2026-06-14"')?.period, { from: "2026-06-14", to: "2026-06-14" }, "one day");
  });

  it("has no period when the time is not named", () => {
    for (const extra of ['"from": "", "to": ""', '"from": null, "to": null', '"x": 1']) {
      const decision = parse(extra);
      assert.deepEqual(decision, { recall: true, query: "моё состояние" }, extra);
    }
  });

  it("never guesses: a broken, impossible, reversed or future time is dropped, a time that is still running ends today", () => {
    for (const extra of [
      '"from": "2026-06-01", "to": ""',
      '"from": "", "to": "2026-06-30"',
      '"from": "июнь", "to": "июнь"',
      '"from": "2026-02-30", "to": "2026-03-05"',
      '"from": "2026-13-01", "to": "2026-13-31"',
      '"from": "2026-06-30", "to": "2026-06-01"',
      '"from": "2027-06-01", "to": "2027-06-30"',
      '"from": 20260601, "to": 20260630',
    ]) {
      assert.equal(parse(extra)?.period, undefined, extra);
    }
    assert.deepEqual(parse('"from": "2026-11-01", "to": "2026-11-30"')?.period, { from: "2026-11-01", to: TODAY });
  });

  it("gives no period when this is not a request to remember", () => {
    assert.deepEqual(parse('"from": "2026-06-01", "to": "2026-06-30"', false), { recall: false, query: "" });
  });

  it("counts today by Moscow time", () => {
    assert.equal(recallGateToday(Date.parse("2026-11-25T20:59:00Z")), "2026-11-25");
    assert.equal(recallGateToday(Date.parse("2026-11-25T21:01:00Z")), "2026-11-26");
  });

  it("is told the date of today by both hosts, and asked for the two days", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"recall": true, "query": "q", "from": "2026-06-01", "to": "2026-06-30"}' } }] }) };
    }) as never;
    const first = await askRecallGate("помнишь июнь?", { apiKey: "k", fetchImpl, today: TODAY });
    const second = await askRecallGateOpenRouter("помнишь июнь?", { apiKey: "k", fetchImpl, today: TODAY });
    for (const result of [first, second]) assert.deepEqual(result.decision?.period, { from: "2026-06-01", to: "2026-06-30" });
    for (const body of bodies) {
      assert.ok(body.messages[0].content.startsWith(RECALL_GATE_SYSTEM_PROMPT));
      assert.match(body.messages[0].content, /Сегодня: 2026-11-26/);
      assert.equal(body.messages[1].content, "помнишь июнь?", "the person's message is not touched");
    }
    assert.match(RECALL_GATE_SYSTEM_PROMPT, /"from"/);
    assert.match(RECALL_GATE_SYSTEM_PROMPT, /"to"/);
    assert.match(RECALL_GATE_SYSTEM_PROMPT, /ГГГГ-ММ-ДД/);
  });
});

interface Row {
  id: string;
  sender: string;
  role: string | null;
  content: string;
  created_at: string;
}

function row(id: string, createdAt: string, content: string, sender = "user"): Row {
  return { id, sender, role: null, content, created_at: createdAt };
}

/** June 2026 with `count` lines of the person spread over the month (each followed by a reply), May and July around it. */
function months(count: number, special: Record<number, string> = {}): Row[] {
  const rows: Row[] = [
    row("may", "2026-05-20T10:00:00Z", "в мае я думала, что в июне поеду на море"),
    row("may-r", "2026-05-20T10:00:30Z", "Расскажи.", "ai"),
    // 31 May 23:30 in UTC is already 1 June in Moscow
    row("edge-in", "2026-05-31T21:30:00Z", "первое июньское сообщение сразу после полуночи"),
  ];
  const start = Date.parse("2026-06-01T08:00:00Z");
  const step = Math.floor((28 * 24 * 3600_000) / count);
  for (let i = 0; i < count; i += 1) {
    const at = start + i * step;
    rows.push(row(`j${i}`, new Date(at).toISOString(), special[i] ?? `июньская заметка номер ${i} о делах`));
    rows.push(row(`j${i}-r`, new Date(at + 30_000).toISOString(), `ответ ${i}`, "ai"));
  }
  rows.push(row("short", "2026-06-15T09:00:00Z", "да"));
  // 30 June 22:00 in UTC is already 1 July in Moscow
  rows.push(row("edge-out", "2026-06-30T22:00:00Z", "это уже июльское сообщение по Москве"));
  rows.push(row("july", "2026-07-10T10:00:00Z", "в июле всё стало иначе"));
  rows.push(row("question", "2026-11-26T01:56:00Z", "а помнишь моё состояние в июне?"));
  return rows;
}

function client(rows: Row[], rpcRows: unknown[] = []) {
  const api = {
    rpc() {
      return Promise.resolve({ data: rpcRows, error: null });
    },
    from() {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        range(from: number, to: number) {
          const newestFirst = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
          return Promise.resolve({ data: newestFirst.slice(from, to + 1), error: null });
        },
      };
      return query;
    },
  };
  return api as never;
}

/** The reranker: a line with «тревожно» is the closest, a line of May is an answer by topic, the rest is weak. */
function stubReranker(options: { status?: number } = {}) {
  const sent: string[] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/rerank")) {
      sent.push(...body.documents);
      if (options.status) return { ok: false, status: options.status, json: async () => ({}), text: async () => "" };
      const results = body.documents.map((text: string, index: number) => ({
        index,
        relevance_score: text.includes("тревожно") ? 0.8 : text.includes("в мае") ? 0.6 : 0.001,
      }));
      return { ok: true, status: 200, json: async () => ({ usage: { total_tokens: 10 }, results }), text: async () => "" };
    }
    return { ok: true, status: 200, text: async () => "", json: async () => ({ data: [], usage: {} }) };
  }) as never;
  return sent;
}

function ask(rows: Row[], period: { from: string; to: string }, options: { rerank?: boolean; query?: string } = {}) {
  return searchConversationArchive(client(rows), {
    conversationId: "c1",
    query: "а помнишь моё состояние в июне?",
    excludeTailCount: 6,
    decision: { recall: true, query: options.query ?? "моё состояние", period },
    rerank: options.rerank === false ? undefined : { apiKey: "cloudru-key" },
  });
}

const JUNE = { from: "2026-06-01", to: "2026-06-30" };

describe("a question about a stretch of time is answered with the person's lines of that time", () => {
  it("gives twelve lines of the person from the whole of the named time, oldest first, by Moscow days", async () => {
    stubReranker();
    const result = await ask(months(60, { 7: "мне было тревожно из-за работы всю неделю" }), JUNE);
    const period = result.period;
    assert.ok(period);
    assert.equal(period.from, "2026-06-01");
    assert.equal(period.to, "2026-06-30");
    assert.equal(period.totalInPeriod, 61, "60 lines and the one just after midnight; not the short one, not July");
    assert.equal(period.lines.length, 12);
    const times = period.lines.map((l) => l.createdAt);
    assert.deepEqual(times, [...times].sort(), "oldest first");
    assert.ok(times[0] >= "2026-05-31T21:00:00" && times[times.length - 1] < "2026-06-30T21:00:00", times.join(" "));
    assert.ok(times.some((t) => t < "2026-06-08"), "from the beginning of the month");
    assert.ok(times.some((t) => t > "2026-06-22"), "and from its end");
    assert.ok(period.lines.some((l) => l.text.includes("тревожно")), "the closest line of its part is the one taken");
    assert.ok(period.lines.every((l) => !l.text.startsWith("ответ ")), "only the person's own lines");
    assert.deepEqual(result.excerpts, [], "everything goes into the one block about the time");
    assert.deepEqual(result.userEvidenceQuotes, []);
  });

  it("also gives the lines about the topic from another time, apart (an event of June may have been told in May)", async () => {
    stubReranker();
    const result = await ask(months(20), JUNE, { query: "море" });
    assert.deepEqual(result.period?.otherTime.map((l) => l.text), ["в мае я думала, что в июне поеду на море"]);
    assert.ok(result.period?.lines.every((l) => !l.text.includes("в мае")));
  });

  it("never gives the question itself as a line", async () => {
    stubReranker();
    const result = await ask(months(3), { from: "2026-11-26", to: "2026-11-26" });
    assert.equal(result.period?.totalInPeriod, 0);
    assert.deepEqual(result.period?.lines, []);
  });

  it("says that there is nothing when the person wrote nothing at that time", async () => {
    stubReranker();
    const result = await ask(months(5), { from: "2026-01-01", to: "2026-01-31" });
    assert.equal(result.period?.totalInPeriod, 0);
    assert.deepEqual(result.period?.lines, []);
  });

  it("gives all of them when there are few", async () => {
    const sent = stubReranker();
    const result = await ask(months(4), JUNE);
    assert.equal(result.period?.lines.length, 5);
    assert.ok(sent.every((d) => !d.includes("июньская заметка")), "nothing to choose between: the reranker is not paid for it");
  });

  it("scores no more than a hundred lines of a long month, spread over all of it", async () => {
    const sent = stubReranker();
    const result = await ask(months(400), JUNE);
    const periodDocuments = sent.filter((d) => d.includes("июньская заметка"));
    assert.ok(periodDocuments.length <= 100 + 15, `sent ${periodDocuments.length}`);
    assert.ok(periodDocuments.some((d) => d.includes("номер 399 ") || d.includes("номер 396 ")), "the end of the month is among them");
    assert.equal(result.period?.totalInPeriod, 401);
    assert.equal(result.period?.lines.length, 12);
  });

  it("still gives lines from the whole time when the reranker does not answer or there is none: the longest of each part", async () => {
    const long = "очень подробный рассказ о том, как прошёл этот день и что было на душе у человека";
    for (const options of [{ rerank: true }, { rerank: false }]) {
      stubReranker({ status: 503 });
      const result = await ask(months(60, { 30: long }), JUNE, options);
      assert.equal(result.period?.lines.length, 12, JSON.stringify(options));
      assert.ok(result.period?.lines.some((l) => l.text === long));
    }
  });

  it("leaves the search as it was when no time was named", async () => {
    stubReranker();
    const result = await searchConversationArchive(client(months(10)), {
      conversationId: "c1", query: "помнишь про море?", excludeTailCount: 2, decision: { recall: true, query: "море" }, rerank: { apiKey: "k" },
    });
    assert.equal(result.period, undefined);
  });
});

describe("the instruction for a question about a stretch of time", () => {
  const lines = [
    { createdAt: "2026-05-31T21:30:00Z", text: "первое июньское сообщение" },
    { createdAt: "2026-06-14T10:00:00Z", text: "мне было тревожно из-за работы" },
  ];
  const full = buildRecallPeriodPrompt({ from: "2026-06-01", to: "2026-06-30", totalInPeriod: 40, lines, otherTime: [{ createdAt: "2026-05-20T10:00:00Z", text: "в мае я думала про море" }] });

  it("names the time and shows every line with the Moscow day it was written", () => {
    assert.match(full, /с 1 июня 2026 г\. по 30 июня 2026 г\./);
    assert.match(full, /- \[1 июня 2026 г\.\] «первое июньское сообщение»/);
    assert.match(full, /- \[14 июня 2026 г\.\] «мне было тревожно из-за работы»/);
    assert.match(full, /из другого времени/);
    assert.match(full, /- \[20 мая 2026 г\.\] «в мае я думала про море»/);
  });

  it("answers from these lines only, calls them a selection, and does not deny what is not in them", () => {
    assert.match(full, /только из этих реплик/);
    assert.match(full, /не пересказывай реплики по очереди/, "live: the answer about June listed all twelve lines one after another");
    assert.match(full, /Это выборка/);
    assert.match(full, /не утверждай, что чего-то не было/);
    assert.match(full, /не достраивай/);
    assert.match(full, /Не опирайся на то, как ты отвечала раньше/);
    assert.match(full, /не упоминай этот блок/);
    assert.doesNotMatch(full, /ни одна реплика не отвечает на вопрос ПРЯМО/, "the rule for a single fact would make every question about a time answered with «I do not see it»");
    assert.ok(!/\bона\b|\bон\b|говорила\b|\bей\b/.test(full), "about a person, not about one gender");
  });

  it("says plainly that there is nothing when there are no lines", () => {
    const empty = buildRecallPeriodPrompt({ from: "2026-01-01", to: "2026-01-31", totalInPeriod: 0, lines: [], otherTime: [] });
    assert.match(empty, /реплик человека в этой беседе нет/);
    assert.match(empty, /Ничего не придумывай/);
    assert.doesNotMatch(empty, /из другого времени/);
    const oneDay = buildRecallPeriodPrompt({ from: "2026-06-14", to: "2026-06-14", totalInPeriod: 0, lines: [], otherTime: [] });
    assert.match(oneDay, /за 14 июня 2026 г\./);
  });

  it("puts its own note at the end of the person's message, for the model only", () => {
    assert.match(RECALL_PERIOD_USER_NOTE, /не упоминай её/);
    assert.notEqual(RECALL_PERIOD_USER_NOTE, RECALL_USER_NOTE);
    const history = [{ role: "user", content: "а помнишь июнь?" }];
    assert.equal(withRecallUserNote(history, RECALL_PERIOD_USER_NOTE)[0].content, `а помнишь июнь?\n\n${RECALL_PERIOD_USER_NOTE}`);
    assert.equal(withRecallUserNote(history)[0].content, `а помнишь июнь?\n\n${RECALL_USER_NOTE}`);
    assert.equal(history[0].content, "а помнишь июнь?");
  });

  it("is used by the chat when the search found a time", () => {
    const chat = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8");
    assert.match(chat, /archiveSearch\.period\s*\?\s*buildRecallPeriodPrompt\(archiveSearch\.period\)/);
    assert.match(chat, /recallUserNote = RECALL_PERIOD_USER_NOTE/);
    assert.match(chat, /withRecallUserNote\(messages, recallUserNote\)/);
  });
});
