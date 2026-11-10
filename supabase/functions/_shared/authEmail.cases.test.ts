import assert from 'node:assert/strict';
import { buildAuthEmails, type AuthEmailEvent } from './authEmail.ts';

const event: AuthEmailEvent = {
  user: { id: '2073ab60-2556-48f3-bfa2-830f2434f482', email: 'owner@example.invalid' },
  email_data: { email_action_type: 'recovery', token_hash: 'test-token', redirect_to: 'https://staysee.ru/' },
};
const options = { authUrl: 'https://project.supabase.co', siteUrl: 'https://staysee.ru' };
const deleted = { room_deletion_requested_at: '2026-11-03T20:58:00Z', room_purge_after: '2027-02-04T00:00:00Z' };

// A deleted-room reset must never carry a working recovery token, even if the token exists in the signed event.
const [notice] = buildAuthEmails(event, deleted, options);
assert.equal(notice.to, 'owner@example.invalid');
assert.match(notice.subject, /удалена/);
assert.match(notice.text, /4 февраля 2027/);
assert.match(notice.text, /восстановить.*нельзя/i);
assert.ok(!JSON.stringify(notice).includes('test-token'));
assert.ok(!notice.html.includes('/verify'));
assert.match(notice.html, /StaySee AI/);
assert.match(notice.html, /bgcolor="#f7f3eb"/);
assert.match(notice.html, /bgcolor="#ffffff"/);
assert.match(notice.html, /<p style="[^"]*color:#302a22[^"]*">Ты запросил/);
assert.match(notice.html, /bgcolor="#d5ad65"/);
assert.match(notice.html, /href="https:\/\/staysee\.ru">Открыть StaySee AI/);
assert.ok(!JSON.stringify(notice).includes('localhost'));

// The actual stored date wins over three months computed anew on every request (legacy 14-day rooms included).
const [legacy] = buildAuthEmails(event, { ...deleted, room_purge_after: '2026-11-17T00:00:00Z' }, options);
assert.match(legacy.text, /17 ноября 2026/);
const [missingDate] = buildAuthEmails(event, { ...deleted, room_purge_after: null }, options);
assert.ok(!missingDate.text.includes('Invalid Date'));
assert.ok(!JSON.stringify(missingDate).includes('test-token'));

// Active and pre-profile accounts keep ordinary recovery links; redirect from the payload cannot leak the token.
for (const profile of [null, { room_deletion_requested_at: null, room_purge_after: null }]) {
  const [mail] = buildAuthEmails(event, profile, options);
  assert.match(mail.html, /token=test-token/);
  assert.match(mail.html, /type=recovery/);
  assert.match(mail.html, /bgcolor="#ffffff"/);
  assert.match(mail.html, /redirect_to=https%3A%2F%2Fstaysee.ru%2F/);
}
const hostile = { ...event, email_data: { ...event.email_data, redirect_to: 'https://attacker.invalid/' } };
assert.ok(!JSON.stringify(buildAuthEmails(hostile, null, options)).includes('attacker.invalid'));
assert.throws(() => buildAuthEmails(event, null, { ...options, authUrl: 'http://localhost:1234' }));

// A deleted account's other access-link requests do not reopen a deleted room either.
for (const action of ['signup', 'invite', 'magiclink', 'email_change', 'reauthentication']) {
  const [mail] = buildAuthEmails({ ...event, email_data: { ...event.email_data, email_action_type: action } }, deleted, options);
  assert.ok(!JSON.stringify(mail).includes('test-token'));
}
for (const action of ['signup', 'invite', 'magiclink', 'recovery', 'reauthentication']) {
  const input = { ...event, email_data: { ...event.email_data, email_action_type: action, token: '123456' } };
  assert.equal(buildAuthEmails(input, null, options).length, 1);
}

// Supabase's documented backwards-compatible secure email-change mapping is counterintuitive.
const change: AuthEmailEvent = {
  ...event, user: { ...event.user, new_email: 'new@example.invalid' },
  email_data: { email_action_type: 'email_change', token_hash: 'NEW_ADDRESS_HASH', token_hash_new: 'OLD_ADDRESS_HASH' },
};
const changed = buildAuthEmails(change, null, options);
assert.equal(changed.length, 2);
assert.equal(changed[0].to, 'owner@example.invalid');
assert.match(changed[0].html, /token=OLD_ADDRESS_HASH/);
assert.equal(changed[1].to, 'new@example.invalid');
assert.match(changed[1].html, /token=NEW_ADDRESS_HASH/);
assert.throws(() => buildAuthEmails({ ...event, email_data: { email_action_type: 'surprise' } }, null, options));
for (const action of ['password_changed_notification', 'email_changed_notification', 'phone_changed_notification', 'identity_linked_notification', 'identity_unlinked_notification', 'mfa_factor_enrolled_notification', 'mfa_factor_unenrolled_notification']) {
  const [security] = buildAuthEmails({ ...event, email_data: { email_action_type: action, old_email: 'previous@example.invalid' } }, null, options);
  assert.ok(!security.html.includes('/verify'));
  assert.match(security.text, /Если это был не ты/);
  // The support address is the one in the offer, the policy and the site, not another mailbox.
  assert.match(security.text, /support\.stayseeai@gmail\.com/);
  assert.ok(!security.text.includes('mail.ru'));
  assert.equal(security.to, action === 'email_changed_notification' ? 'previous@example.invalid' : 'owner@example.invalid');
}
// A stolen account's new email must not receive the only warning intended for the previous owner.
const notification: AuthEmailEvent = {
  user: { ...event.user, email: 'new@example.invalid' },
  email_data: { email_action_type: 'email_changed_notification', old_email: 'previous@example.invalid' },
};
assert.equal(buildAuthEmails(notification, null, options)[0].to, 'previous@example.invalid');
assert.throws(() => buildAuthEmails({ ...notification, email_data: { email_action_type: 'email_changed_notification' } }, null, options));
assert.throws(() => buildAuthEmails({ ...notification, email_data: { ...notification.email_data, old_email: 'x\r\nBcc: y@invalid' } }, null, options));
assert.throws(() => buildAuthEmails({ ...event, user: { ...event.user, email: 'x\r\nBcc: y@invalid' } }, null, options));
console.log('authEmail cases passed');
