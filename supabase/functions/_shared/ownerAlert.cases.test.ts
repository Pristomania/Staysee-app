import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deliverToOwner, ownerAlertMailer, type PostboxMail } from "./ownerAlert.ts";
import { resetProviderAlertsForTests, sendProviderAlertSafely } from "./providerAlert.ts";
import { sendMemoryV3TelegramAlertSafely } from "./memoryV3/telegramAlert.ts";
import { sendMemoryV3StaleAlertSafely } from "./memoryV3/staleAlert.ts";

const BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd12345";
const CHAT_ID = "123456789";
const SETTINGS: Record<string, string> = {
  STAYSEE_ALERT_EMAIL: "owner@example.test",
  POSTBOX_SMTP_USER: "smtp-user",
  POSTBOX_SMTP_PASSWORD: "smtp-password",
};
const reader = (values: Record<string, string>) => (name: string) => values[name];

function mailbox() {
  const sent: string[] = [];
  return { sent, mailer: async (text: string) => { sent.push(text); return true; } };
}

describe("owner alerts by e-mail", () => {
  it("is off unless the address and both mail credentials are set", () => {
    assert.equal(ownerAlertMailer({ read: reader({}) }), null);
    for (const missing of Object.keys(SETTINGS)) {
      assert.equal(ownerAlertMailer({ read: reader({ ...SETTINGS, [missing]: "" }) }), null, missing);
    }
    assert.equal(ownerAlertMailer({ read: reader({ ...SETTINGS, STAYSEE_ALERT_EMAIL: "not an address" }) }), null);
    assert.notEqual(ownerAlertMailer({ read: reader(SETTINGS) }), null);
  });

  it("sends the text to the configured address from the product's sender", async () => {
    const mails: PostboxMail[] = [];
    const mailer = ownerAlertMailer({ read: reader(SETTINGS), send: async (mail) => { mails.push(mail); } });
    assert.equal(await mailer!("⚠️ StaySee: первая строка\nвторая строка"), true);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, "owner@example.test");
    assert.equal(mails[0].from, '"StaySee AI" <no-reply@staysee.ru>');
    assert.equal(mails[0].subject, "StaySee: первая строка");
    assert.equal(mails[0].text, "⚠️ StaySee: первая строка\nвторая строка");
    assert.equal(mails[0].user, "smtp-user");
    assert.equal(mails[0].password, "smtp-password");
  });

  it("keeps the subject short", async () => {
    const mails: PostboxMail[] = [];
    const mailer = ownerAlertMailer({ read: reader(SETTINGS), send: async (mail) => { mails.push(mail); } });
    await mailer!(`⚠️ StaySee: ${"длинно ".repeat(60)}`);
    assert.ok(mails[0].subject.length <= 100, String(mails[0].subject.length));
  });

  it("answers false, without throwing, when the mail fails or hangs", async () => {
    const failing = ownerAlertMailer({ read: reader(SETTINGS), send: async () => { throw new Error("smtp"); } });
    assert.equal(await failing!("x"), false);
    const hanging = ownerAlertMailer({ read: reader(SETTINGS), send: () => new Promise<void>(() => {}), timeoutMs: 20 });
    assert.equal(await hanging!("x"), false);
  });

  it("delivers when one channel works and fails when none does", async () => {
    await deliverToOwner([async () => { throw new Error("telegram"); }, async () => true]);
    await assert.rejects(deliverToOwner([async () => { throw new Error("telegram"); }, async () => false]));
    await assert.rejects(deliverToOwner([]));
  });

  it("in a connectivity test demands that every channel works", async () => {
    await deliverToOwner([async () => true, async () => undefined], { requireAll: true });
    await assert.rejects(deliverToOwner([async () => true, async () => false], { requireAll: true }));
  });
});

describe("every alert also goes by e-mail", () => {
  it("the model-host alert: without Telegram, and when Telegram fails", async () => {
    resetProviderAlertsForTests();
    const first = mailbox();
    assert.equal(await sendProviderAlertSafely("balance_empty", { now: 1, botToken: null, chatId: null, mailer: first.mailer }), true);
    assert.equal(first.sent.length, 1);
    assert.match(first.sent[0], /закончились деньги/u);
    assert.equal(await sendProviderAlertSafely("balance_empty", { now: 2, botToken: null, chatId: null, mailer: first.mailer }), false, "once in the window");
    assert.equal(first.sent.length, 1);

    resetProviderAlertsForTests();
    const second = mailbox();
    const delivered = await sendProviderAlertSafely("search_failed", {
      now: 3, botToken: BOT_TOKEN, chatId: CHAT_ID, mailer: second.mailer,
      fetchImpl: async () => { throw new Error("network"); },
    });
    assert.equal(delivered, true);
    assert.equal(second.sent.length, 1);
  });

  it("the memory error alert: reserved once, sent by mail even with no chat", async () => {
    const box = mailbox();
    let reserved = 0;
    const calls: string[] = [];
    await sendMemoryV3TelegramAlertSafely({
      botToken: BOT_TOKEN, chatId: null, path: "write", diagnosticCode: "state_write_failed",
      reserveAlertKey: async () => { reserved += 1; return true; },
      fetchImpl: async (url) => { calls.push(url); },
      mailer: box.mailer,
    });
    assert.equal(reserved, 1);
    assert.equal(calls.length, 0);
    assert.equal(box.sent.length, 1);
    assert.match(box.sent[0], /Code: state_write_failed/u);
  });

  it("the memory error alert: both channels carry the same text, and a failing one does not stop the other", async () => {
    const box = mailbox();
    const bodies: string[] = [];
    await sendMemoryV3TelegramAlertSafely({
      botToken: BOT_TOKEN, chatId: CHAT_ID, path: "read", diagnosticCode: "load_failed",
      reserveAlertKey: async () => true,
      fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body).text); throw new Error("telegram"); },
      mailer: box.mailer,
    });
    assert.equal(box.sent.length, 1);
    assert.deepEqual(bodies, box.sent);
  });

  it("the silent-memory alert: by mail even with no chat, naming nobody", async () => {
    const box = mailbox();
    const userId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    await sendMemoryV3StaleAlertSafely({
      botToken: null, chatId: null,
      row: { userId, conversationId, scope: "dialogue", newMessageCount: 27 },
      fetchImpl: async () => { throw new Error("must not be called"); },
      mailer: box.mailer,
    });
    assert.equal(box.sent.length, 1);
    assert.match(box.sent[0], /тишина/u);
    assert.equal(box.sent[0].includes(userId), false);
    assert.equal(box.sent[0].includes(conversationId), false);
  });
});
