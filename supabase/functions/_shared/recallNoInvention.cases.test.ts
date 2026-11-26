import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { formatArchiveExcerptsForPrompt, formatUserEvidenceForPrompt } from "./conversationRetrieval.ts";
import { RECALL_STRICT_RULE, RECALL_TURN_TEMPERATURE, RECALL_USER_NOTE, buildRecallGroundingPrompt, withRecallUserNote } from "./recallGrounding.ts";

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
    assert.match(withLines, /Дата в метке реплики — день, когда человек это написал/);
    assert.match(withLines, /время самого события называй лишь если оно сказано в самой реплике/);
    assert.doesNotMatch(withLines, /не называй месяц или день, если их нет в метке/, "the old sentence invited naming the date of the label as the date of the event");
    assert.match(withLines, /не угадывай и не достраивай/i);
    assert.match(withLines, /не упоминай этот блок/);
    const empty = buildRecallGroundingPrompt({ evidenceCount: 0, archiveCount: 0 });
    assert.match(empty, /ничего не нашёл/);
    assert.match(empty, /Ничего не придумывай/);
    assert.doesNotMatch(withLines, /Ничего не придумывай/, "the line for an empty search is only there when the search is empty");
  });

  it("the found lines say that the date in brackets is the day it was written, not the day of the event (live: «это было в ноябре» for a New Year quarrel)", () => {
    assert.match(formatUserEvidenceForPrompt(quote), /Дата в скобках — день, когда человек это написал, а не день события/);
    assert.match(formatArchiveExcerptsForPrompt(excerpt), /Дата в скобках — день, когда это написано, а не день события/);
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

  it("the strict rule is in the instruction for every recall turn, and the note goes to the end of the person's last message for the model only", () => {
    for (const counts of [{ evidenceCount: 0, archiveCount: 0 }, { evidenceCount: 3, archiveCount: 2 }]) {
      assert.ok(buildRecallGroundingPrompt(counts).includes(RECALL_STRICT_RULE));
    }
    assert.match(RECALL_STRICT_RULE, /ТОЛЬКО по репликам выше/);
    assert.match(RECALL_STRICT_RULE, /Не опирайся на то, как ты отвечала раньше/);
    assert.match(RECALL_USER_NOTE, /не упоминай её/);

    const history = [
      { role: "user", content: "привет" },
      { role: "assistant", content: "Привет." },
      { role: "user", content: "вспомни, как зовут мою собаку" },
    ];
    const sent = withRecallUserNote(history);
    assert.equal(sent.length, 3);
    assert.equal(sent[2].content, `вспомни, как зовут мою собаку\n\n${RECALL_USER_NOTE}`);
    assert.equal(history[2].content, "вспомни, как зовут мою собаку", "the saved message is not touched");
    assert.deepEqual(sent.slice(0, 2), history.slice(0, 2));
    const endsWithAnswer = [{ role: "user", content: "а" }, { role: "assistant", content: "б" }];
    assert.equal(withRecallUserNote(endsWithAnswer), endsWithAnswer, "no user message at the end: nothing is added");
    assert.deepEqual(withRecallUserNote([]), []);
  });

  it("the chat gives the model the note only on a recall turn", () => {
    assert.match(chat, /const modelMessages = recallTurn \? withRecallUserNote\(messages, recallUserNote\) : messages;/);
    assert.match(chat, /let recallUserNote: string = RECALL_USER_NOTE;/);
  });
});
