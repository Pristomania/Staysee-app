import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { formatArchiveExcerptsForPrompt, formatUserEvidenceForPrompt } from "./conversationRetrieval.ts";
import { RECALL_TURN_TEMPERATURE, buildRecallGroundingPrompt } from "./recallGrounding.ts";

const chat = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8");
const quote = [{ createdAt: "2026-05-12T10:00:00Z", text: "я переехала в другой город" }];
const excerpt = [{ userText: "я переехала в другой город", assistantText: "Это большая перемена.", createdAt: "2026-05-12T10:00:00Z", score: 0.9 }];

describe("a question about what was said before is answered from the lines, not from imagination", () => {
  it("the found lines are called close, not confirmed, and may not answer the question (a live run: 5 of 8 questions about things never said got invented details)", () => {
    for (const block of [formatUserEvidenceForPrompt(quote), formatArchiveExcerptsForPrompt(excerpt)]) {
      assert.match(block, /может не отвечать|близкая тема не значит/, "says that a close line may not answer");
      assert.match(block, /Не добавляй подробностей|без достроенных подробностей/, "forbids built-up details");
      assert.match(block, /не нашла этого/, "gives the honest way out");
    }
    const evidence = formatUserEvidenceForPrompt(quote);
    assert.doesNotMatch(evidence, /ПОДТВЕРЖДЁННЫЕ/, "the lines are not called confirmed");
    assert.doesNotMatch(evidence, /Если блок не пуст/, "a non-empty block does not mean that the topic was discussed");
    assert.doesNotMatch(evidence, /отрицать весь разговор нельзя/);
  });

  it("the instruction takes every detail from the line, forbids joining lines into a story, and gives the honest answer when nothing is found", () => {
    const withLines = buildRecallGroundingPrompt({ evidenceCount: 2, archiveCount: 2 });
    assert.match(withLines, /дословно/);
    assert.match(withLines, /не соединяй разные реплики в одну историю/i);
    assert.match(withLines, /не называй месяц или день, если их нет в метке/);
    assert.match(withLines, /не угадывай и не достраивай/i);
    assert.match(withLines, /не упоминай этот блок/);
    const empty = buildRecallGroundingPrompt({ evidenceCount: 0, archiveCount: 0 });
    assert.match(empty, /ничего не нашёл/);
    assert.match(empty, /Ничего не придумывай/);
    assert.doesNotMatch(withLines, /Ничего не придумывай/, "the line for an empty search is only there when the search is empty");
  });

  it("the instruction speaks about a person, not about one topic or one gender", () => {
    const text = buildRecallGroundingPrompt({ evidenceCount: 3, archiveCount: 3 });
    for (const word of ["ссор", "сын", "мужчин"]) assert.ok(!text.includes(word), word);
    assert.ok(!/\bона\b|говорила\b|\bей\b/.test(text));
  });

  it("the turn is answered colder, and the instruction stands last in the prompt, after the date and the pause", () => {
    assert.equal(RECALL_TURN_TEMPERATURE, 0.3);
    assert.match(chat, /const turnTemperature = recallTurn \? Math\.min\(tierCfg\.temperature, RECALL_TURN_TEMPERATURE\) : tierCfg\.temperature;/);
    const pause = chat.indexOf("const timeGapPrompt = buildTimeGapPrompt(timeGap);");
    const last = chat.indexOf("systemPrompt = [systemPrompt, recallGroundingBlock].join");
    const calls = chat.indexOf("let result = await callModel(");
    assert.ok(pause > 0 && last > pause && last < calls, "appended after the date and the pause, before the call");
    assert.match(chat.slice(calls, calls + 260), /turnTemperature/);
    assert.ok(!/systemPrompt = \[systemPrompt, recallGrounding\]\.join/.test(chat), "no longer added in the middle");
  });

  it("the other blocks name the lines the same way", () => {
    const context = readFileSync(new URL("./context.ts", import.meta.url), "utf8");
    assert.match(context, /БЛИЗКИЕ РЕПЛИКИ/);
    assert.doesNotMatch(context, /ПОДТВЕРЖДЁННЫЕ СЛОВА/);
  });
});
