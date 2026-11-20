import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as retrieval from "./conversationRetrieval.ts";
import {
  RETRIEVAL_MAX_FETCH,
  RETRIEVAL_RECENT_WINDOW,
  fetchConversationMessagesForRetrieval,
  formatArchiveExcerptsForPrompt,
  formatUserEvidenceForPrompt,
  hasRecallIntent,
  rankArchiveExcerpts,
} from "./conversationRetrieval.ts";

const source = readFileSync(new URL("./conversationRetrieval.ts", import.meta.url), "utf8");
const memorySource = readFileSync(new URL("./memory.ts", import.meta.url), "utf8");

interface Row {
  id: string;
  sender: string;
  role: string | null;
  content: string;
  created_at: string;
}

/** A conversation of `count` messages (user, ai, user, ai …), one minute apart, message 0 the oldest. */
function conversation(count: number, special: Record<number, string> = {}): Row[] {
  const start = Date.parse("2026-01-01T10:00:00Z");
  return Array.from({ length: count }, (_, i) => ({
    id: `m${String(i).padStart(5, "0")}`,
    sender: i % 2 === 0 ? "user" : "ai",
    role: null,
    content: special[i] ?? (i % 2 === 0 ? `обычная реплика номер ${i}` : `ответ номер ${i}`),
    created_at: new Date(start + i * 60_000).toISOString(),
  }));
}

/** A client that serves the messages table the way the database does: newest first, a page at a time. */
function fakeMessagesClient(rows: Row[], options: { failAtPage?: number } = {}) {
  const pages: Array<[number, number]> = [];
  const client = {
    from(table: string) {
      assert.equal(table, "messages");
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        range(from: number, to: number) {
          pages.push([from, to]);
          if (options.failAtPage !== undefined && pages.length === options.failAtPage) {
            return Promise.resolve({ data: null, error: { message: "boom" } });
          }
          const newestFirst = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
          return Promise.resolve({ data: newestFirst.slice(from, to + 1), error: null });
        },
      };
      return query;
    },
  };
  return { client: client as never, pages };
}

describe("the archive search reads the whole conversation, not its first messages", () => {
  it("reads only the newest window when nobody asked to remember, oldest first", async () => {
    const { client, pages } = fakeMessagesClient(conversation(1500));
    const got = await fetchConversationMessagesForRetrieval(client, "c1", "recent");
    assert.equal(got.length, RETRIEVAL_RECENT_WINDOW);
    assert.equal(got[got.length - 1].content, "ответ номер 1499", "the newest message is there");
    assert.ok(got[0].created_at < got[1].created_at, "oldest first");
    assert.equal(pages.length, 1);
  });

  it("reads every message of a long conversation when someone asks to remember (the first message too)", async () => {
    const { client, pages } = fakeMessagesClient(conversation(2500, { 0: "самое первое сообщение" }));
    const got = await fetchConversationMessagesForRetrieval(client, "c1", "all");
    assert.equal(got.length, 2500);
    assert.equal(got[0].content, "самое первое сообщение");
    assert.equal(got[0].role, "user");
    assert.equal(got[1].role, "assistant");
    assert.equal(pages.length, 3, "pages of 1000: 1000 + 1000 + 500, then it stops");
  });

  it("never reads more than the cap, and keeps the newest when it must cut", async () => {
    const { client } = fakeMessagesClient(conversation(RETRIEVAL_MAX_FETCH + 700));
    const got = await fetchConversationMessagesForRetrieval(client, "c1", "all");
    assert.equal(got.length, RETRIEVAL_MAX_FETCH);
    assert.equal(got[got.length - 1].content, `ответ номер ${RETRIEVAL_MAX_FETCH + 699}`);
  });

  it("returns what it has when a later page fails, and nothing when the first fails", async () => {
    const later = fakeMessagesClient(conversation(2500), { failAtPage: 2 });
    assert.equal((await fetchConversationMessagesForRetrieval(later.client, "c1", "all")).length, 1000);
    const first = fakeMessagesClient(conversation(2500), { failAtPage: 1 });
    assert.equal((await fetchConversationMessagesForRetrieval(first.client, "c1", "all")).length, 0);
  });

  it("finds an old exchange by the person's own words, even when it lies far before the newest messages", async () => {
    const rows = conversation(1200, { 20: "я хожу на йогу по вторникам и мне там спокойно", 21: "Рада, что у тебя есть место, где спокойно." });
    const { client } = fakeMessagesClient(rows);
    const messages = await fetchConversationMessagesForRetrieval(client, "c1", "all");
    const hits = rankArchiveExcerpts(messages, "помнишь, я говорила про йогу", 20);
    assert.ok(hits.some((h) => h.userText.includes("йогу")), "the old exchange is among the hits");
    assert.ok(hits[0].userText.includes("йогу"), "and it comes first");
  });
});

describe("nothing in the search is written for one story", () => {
  it("does not add words the person did not say, and does not guess a topic from the words", () => {
    assert.equal((retrieval as Record<string, unknown>).expandRecallTopicStems, undefined);
    for (const word of ["манипул", "улич", "обвин", "FIGHT_", "мужчин", "поругал", "ссор", "развод", "предател"]) {
      assert.ok(!source.includes(word), `conversationRetrieval.ts must not contain "${word}"`);
    }
  });

  it("the recall block has no topic written into it", () => {
    const block = memorySource.slice(memorySource.indexOf("export function buildRecallGroundingPrompt"), memorySource.indexOf("const ACUTE_RISK_RE"));
    for (const word of ["ссор", "сын", "мужчин"]) {
      assert.ok(!block.includes(word), `the recall block must not contain "${word}"`);
    }
  });

  it("ordinary words of a story do not wake the recall mode", () => {
    for (const text of ["мы вчера поругались", "я ему не доверяю", "он сказал, что приедет к ужину и опять опоздал"]) {
      assert.equal(hasRecallIntent(text), text.includes("сказал"), text);
    }
    assert.equal(hasRecallIntent("помнишь, что я говорила про маму?"), true);
    assert.equal(hasRecallIntent("вспомни, пожалуйста"), true);
  });

  it("the prompt blocks speak about a person, not about one gender, and show the year of an old line", () => {
    const evidence = formatUserEvidenceForPrompt([{ createdAt: "2026-05-12T10:00:00Z", text: "я переехала в другой город" }]);
    const archive = formatArchiveExcerptsForPrompt([
      { userText: "я переехала в другой город", assistantText: "Это большая перемена.", createdAt: "2026-05-12T10:00:00Z", score: 1 },
    ]);
    for (const block of [evidence, archive]) {
      assert.match(block, /2026/, "an old line carries its year");
      assert.ok(!/\bона\b|говорила\b|\bей\b/.test(block.split("\n").slice(0, 7).join(" ")), "the instructions do not assume a gender");
    }
  });
});
