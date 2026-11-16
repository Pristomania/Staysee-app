import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_LIMIT, MAX_LIMIT, buildQuery, formatReport, maskEmail, parseArgs } from "./feedback-report.mjs";

const source = readFileSync(new URL("./feedback-report.mjs", import.meta.url), "utf8");

const row = {
  created_at: "2026-11-17T11:05:00Z",
  rating: -1,
  comment: "слишком длинно\nи без вопроса",
  user_id: "a1b2c3d4-0000-0000-0000-000000000000",
  email: "anna@example.com",
  tier: "free",
  conversation_id: "c1000000-0000-0000-0000-00000000000a",
  message_id: "11111111-0000-0000-0000-000000000002",
  reply_excerpt: "Ответ\nв две строки",
  previous_user_message: "Мне тяжело",
  model_guess: "moonshotai/kimi-k2.6",
  prompt_version_guess: "v2",
};

describe("the feedback report", () => {
  it("reads the options and keeps them in bounds", () => {
    assert.deepEqual(parseArgs([]), { bad: false, limit: DEFAULT_LIMIT, since: null });
    assert.deepEqual(parseArgs(["--bad", "--limit=50", "--since=2026-11-17"]), { bad: true, limit: 50, since: "2026-11-17" });
    assert.equal(parseArgs(["--limit=100000"]).limit, MAX_LIMIT);
    assert.equal(parseArgs(["--limit=abc"]).limit, DEFAULT_LIMIT);
    assert.equal(parseArgs(["--since=вчера"]).since, null);
  });

  it("asks only for what was wanted, newest first", () => {
    assert.equal(buildQuery({ bad: false, limit: 30, since: null }), "message_feedback_review?select=*&order=created_at.desc&limit=30");
    assert.equal(buildQuery({ bad: true, limit: 5, since: "2026-11-17" }), "message_feedback_review?select=*&order=created_at.desc&limit=5&rating=eq.-1&created_at=gte.2026-11-17");
  });

  it("shows who, which answer, what was asked and what the person wrote, with the address masked", () => {
    const text = formatReport([row, { ...row, rating: 1, comment: null, email: null, model_guess: null }]);
    assert.match(text, /показано 2 \(плохих 1, хороших 1\)/);
    assert.match(text, /\[ПЛОХО\] .*аккаунт a1b2c3d4 \(a\*\*\*@example\.com, тариф free\) \| модель: moonshotai\/kimi-k2\.6/);
    assert.match(text, /Вопрос: «Мне тяжело»/);
    assert.match(text, /Ответ:  «Ответ \/ в две строки»/);
    assert.match(text, /Написал\(а\): «слишком длинно \/ и без вопроса»/);
    assert.match(text, /\[ХОРОШО\] .*почта неизвестна.*модель: \?/);
    assert.doesNotMatch(text, /anna@example\.com/, "the full address is never printed");
  });

  it("says plainly when there is nothing yet", () => {
    assert.match(formatReport([]), /Пока ничего нет/);
  });

  it("masks an address and survives a missing one", () => {
    assert.equal(maskEmail("Nastya@Example.com"), "N***@Example.com");
    assert.equal(maskEmail(null), "почта неизвестна");
  });

  it("only reads: no write, no file", () => {
    assert.doesNotMatch(source, /method:\s*["'](POST|PATCH|PUT|DELETE)/i);
    assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream/);
  });
});
