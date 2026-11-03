/**
 * Run: npx tsx src/lib/messageCounter.cases.test.ts
 * The counter the person sees in the cabinet and the warning ten messages before the end. It repeats the rules the
 * database applies when a message arrives (migrations 085, 086, 088), so what is shown is what will happen.
 */

import {
  type MessageCounter,
  WARN_AT_REMAINING,
  counterLine,
  exhaustedReply,
  lowMessagesLine,
  messageCounter,
  packMessagesLeft,
  pluralMessages,
  renewalLine,
} from './messageCounter.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const NOW = new Date('2026-11-01T12:00:00Z');

function must(row: Parameters<typeof messageCounter>[0], now: Date): MessageCounter {
  const counter = messageCounter(row, now);
  if (!counter) throw new Error('the counter must exist for this row');
  return counter;
}
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

// ── free: 50 messages; they return 3 months after the last answered message ───────────────────────────────
{
  const c = must({ tier: 'free', period_requests_used: 13, period_started_at: daysAgo(5), last_request_at: daysAgo(1) }, NOW);
  assert(!c.unlimited && c.total === 50 && c.used === 13 && c.remaining === 37, 'free: 13 of 50 used, 37 left');
  assert(!c.warn, 'no warning with 37 left');
  assert(counterLine(c) === 'Осталось 37 из 50 сообщений', `counter line: ${counterLine(c)}`);
}
{
  const c = must({ tier: 'free', period_requests_used: 40, period_started_at: daysAgo(30), last_request_at: daysAgo(2) }, NOW);
  assert(c.remaining === 10 && c.warn, `the warning starts at ${WARN_AT_REMAINING} left`);
  assert(lowMessagesLine(c) === 'Осталось 10 сообщений', lowMessagesLine(c));
}
{
  const c = must({ tier: 'free', period_requests_used: 49, period_started_at: daysAgo(30), last_request_at: daysAgo(1) }, NOW);
  assert(c.remaining === 1 && c.warn, 'one left');
  assert(lowMessagesLine(c) === 'Остаётся 1 сообщение', lowMessagesLine(c));
}
{
  const c = must({ tier: 'free', period_requests_used: 50, period_started_at: daysAgo(30), last_request_at: daysAgo(1) }, NOW);
  assert(c.remaining === 0 && c.warn, 'none left');
  assert(counterLine(c) === 'Сообщения закончились', counterLine(c));
  // they return 3 calendar months after the last answered message
  assert(c.renewsAt?.toISOString().slice(0, 10) === '2027-02-01' || c.renewsAt?.toISOString().slice(0, 10) === '2027-01-31', `renews ${c.renewsAt?.toISOString()}`);
  // When they are gone, the person is told the day they come back, not "in three months" (they may look again in a month).
  assert(/^Сообщения закончились\. Новые будут доступны (31 января|1 февраля) 2027$/.test(lowMessagesLine(c, NOW)), lowMessagesLine(c, NOW));
  assert(/^Новые 50 сообщений будут доступны (31 января|1 февраля) 2027$/.test(renewalLine(c, 'free', NOW)), renewalLine(c, 'free', NOW));
  const reply = exhaustedReply(c, 'free', NOW);
  assert(reply !== null && /^Бесплатные сообщения закончились\. Новые 50 сообщений будут доступны (31 января|1 февраля) 2027\. Чтобы продолжить раньше, нужен тариф\.$/.test(reply), String(reply));
  assert(!/₽|\$|руб|потол/i.test(String(reply)), 'the refusal says nothing about money');
}
{
  // Messages left: the general phrase stays (the date moves with every message, so it would be a wrong promise).
  const c = must({ tier: 'free', period_requests_used: 13, period_started_at: daysAgo(5), last_request_at: daysAgo(1) }, NOW);
  assert(/через 3 месяца после последнего сообщения/.test(renewalLine(c, 'free', NOW)), renewalLine(c, 'free', NOW));
  assert(exhaustedReply(c, 'free', NOW) === null, 'no refusal text while there are messages');
}
{
  // 3 months of silence: the count starts again, as the database does at the next message
  const c = must({ tier: 'free', period_requests_used: 50, period_started_at: daysAgo(200), last_request_at: daysAgo(95) }, NOW);
  assert(c.used === 0 && c.remaining === 50 && !c.warn, 'after 3 months the 50 are back');
  // 2 months of silence is not enough
  const d = must({ tier: 'free', period_requests_used: 50, period_started_at: daysAgo(200), last_request_at: daysAgo(60) }, NOW);
  assert(d.remaining === 0, 'not yet');
  // nobody answered yet: counted from the period start
  const e = must({ tier: 'free', period_requests_used: 0, period_started_at: daysAgo(10), last_request_at: null }, NOW);
  assert(e.remaining === 50, 'a new person has all 50');
}

// ── basic: 400 per 30 days ───────────────────────────────────────────────────────────────────────────
{
  const c = must({ tier: 'basic', period_requests_used: 100, period_started_at: daysAgo(10), last_request_at: daysAgo(1) }, NOW);
  assert(c.total === 400 && c.remaining === 300 && !c.warn, 'basic: 300 of 400 left');
  assert(c.renewsAt?.toISOString().slice(0, 10) === '2026-11-21', `renews on day 30 of the period: ${c.renewsAt?.toISOString()}`);
  assert(/^Обновится 21 ноября/.test(renewalLine(c, 'basic')), renewalLine(c, 'basic'));
}
{
  // a paid plan with nothing left: the day the new limit opens (same year: no year written)
  const c = must({ tier: 'basic', period_requests_used: 400, period_started_at: daysAgo(10), last_request_at: daysAgo(1) }, NOW);
  assert(c.remaining === 0 && c.available === 0, 'basic: nothing left');
  assert(renewalLine(c, 'basic', NOW) === 'Новые 400 сообщений будут доступны 21 ноября', renewalLine(c, 'basic', NOW));
  assert(lowMessagesLine(c, NOW) === 'Сообщения закончились. Новые будут доступны 21 ноября', lowMessagesLine(c, NOW));
  assert(exhaustedReply(c, 'basic', NOW) === 'Сообщения на этот месяц закончились. Новые 400 сообщений будут доступны 21 ноября.', String(exhaustedReply(c, 'basic', NOW)));
}
{
  // the period is over: a new one starts with the next message
  const c = must({ tier: 'basic', period_requests_used: 400, period_started_at: daysAgo(31), last_request_at: daysAgo(31) }, NOW);
  assert(c.used === 0 && c.remaining === 400, 'a new period: all 400');
}
{
  const c = must({ tier: 'basic', period_requests_used: 395, period_started_at: daysAgo(3), last_request_at: daysAgo(0) }, NOW);
  assert(c.remaining === 5 && c.warn && lowMessagesLine(c) === 'Осталось 5 сообщений', 'basic: five left warns');
}

// ── premium and the unlimited mark ───────────────────────────────────────────────────────────────────
{
  const c = must({ tier: 'premium', period_requests_used: 10, period_started_at: daysAgo(1), last_request_at: daysAgo(0) }, NOW);
  assert(c.total === 1000 && c.remaining === 990, 'premium: 1000');
}
{
  const c = must({ tier: 'premium', period_requests_used: 5000, period_started_at: daysAgo(1), unlimited_usage: true }, NOW);
  assert(c.unlimited && !c.warn, 'an unlimited account never warns');
  assert(counterLine(c) === 'Без ограничений', counterLine(c));
}

// ── what we do not know is never shown as a number ───────────────────────────────────────────────────
{
  assert(messageCounter(null, NOW) === null, 'no row: no counter');
  const c = must({ tier: 'free' }, NOW);
  assert(c !== null && c.used === 0 && c.remaining === 50, 'a row from a database without the new columns counts from zero');
  const wrong = must({ tier: 'free', period_requests_used: -5 }, NOW);
  assert(wrong !== null && wrong.used === 0, 'a negative count is zero');
  const over = must({ tier: 'free', period_requests_used: 70, last_request_at: daysAgo(1), period_started_at: daysAgo(3) }, NOW);
  assert(over !== null && over.remaining === 0, 'more than the plan gives is zero left, never negative');
}

// ── bought messages (migration 090): spent after the plan's, counted with it ─────────────────────────────
{
  const future = new Date(NOW.getTime() + 100 * 86_400_000).toISOString();
  const past = daysAgo(1);
  const free = { tier: 'free', period_requests_used: 30, last_request_at: daysAgo(1), period_started_at: daysAgo(5) };

  // only packs that are not used up, not voided and not expired count
  assert(packMessagesLeft([{ messages_left: 60, expires_at: future }, { messages_left: 40, expires_at: future }], NOW) === 100, 'packs add up');
  assert(packMessagesLeft([{ messages_left: 50, expires_at: past }], NOW) === 0, 'an expired pack is nothing');
  assert(packMessagesLeft([{ messages_left: 50, expires_at: future, voided_at: past }], NOW) === 0, 'a voided pack is nothing');
  assert(packMessagesLeft([{ messages_left: 0, expires_at: future }], NOW) === 0, 'an empty pack is nothing');
  assert(packMessagesLeft([{ messages_left: 5 }], NOW) === 0, 'a pack with no end date is not trusted');
  assert(packMessagesLeft(null, NOW) === 0 && packMessagesLeft(undefined, NOW) === 0 && packMessagesLeft([], NOW) === 0, 'no packs');

  const none = must(free, NOW);
  assert(none.packRemaining === 0 && none.available === 20 && none.remaining === 20, 'without packs nothing changes');
  assert(counterLine(none) === 'Осталось 20 из 50 сообщений', counterLine(none));

  const withPack = messageCounter(free, NOW, [{ messages_left: 100, expires_at: future }]);
  assert(withPack !== null && withPack.remaining === 20 && withPack.packRemaining === 100 && withPack.available === 120, 'plan and bought messages are counted apart and together');
  assert(counterLine(withPack) === 'Осталось 20 из 50 сообщений · докупленных 100', counterLine(withPack));
  assert(withPack.warn === false, 'no warning while the bought messages are plenty');
  assert(lowMessagesLine(withPack) === 'Осталось 120 сообщений', 'the warning line speaks of everything available');

  // the plan is spent, the pack goes on
  const spent = messageCounter({ ...free, period_requests_used: 50 }, NOW, [{ messages_left: 100, expires_at: future }]);
  assert(spent !== null && spent.remaining === 0 && spent.available === 100, 'plan spent, pack left');
  assert(counterLine(spent) === 'Осталось 100 сообщений из докупленных', counterLine(spent));
  const one = messageCounter({ ...free, period_requests_used: 50 }, NOW, [{ messages_left: 1, expires_at: future }]);
  assert(one !== null && one.warn && lowMessagesLine(one) === 'Остаётся 1 сообщение', 'the last bought message warns');

  // the warning starts from ten of everything
  const low = messageCounter({ ...free, period_requests_used: 50 }, NOW, [{ messages_left: 10, expires_at: future }]);
  assert(low !== null && low.warn && lowMessagesLine(low) === 'Осталось 10 сообщений', 'ten bought messages warn');
  const enough = messageCounter({ ...free, period_requests_used: 50 }, NOW, [{ messages_left: 11, expires_at: future }]);
  assert(enough !== null && !enough.warn, 'eleven do not');

  // everything gone
  const gone = messageCounter({ ...free, period_requests_used: 50 }, NOW, [{ messages_left: 0, expires_at: future }]);
  assert(gone !== null && gone.available === 0 && counterLine(gone) === 'Сообщения закончились' && gone.warn, 'nothing left at all is the end');
  // the plan's own messages are out but the bought ones remain: no refusal, and the date of the plan's return is still shown
  assert(exhaustedReply(spent, 'free', NOW) === null, 'bought messages left: nothing is refused');
  assert(/^Новые 50 сообщений будут доступны /.test(renewalLine(spent, 'free', NOW)), renewalLine(spent, 'free', NOW));
  // no date known (a fresh period): only the plain words
  const noDate = must({ tier: 'basic', period_requests_used: 400 }, NOW);
  assert(lowMessagesLine(noDate, NOW) === 'Сообщения закончились' && exhaustedReply(noDate, 'basic', NOW) === null, 'without a known date nothing is promised');

  // the free messages come back after three idle months, the bought ones are not touched by that
  const renewed = messageCounter({ tier: 'free', period_requests_used: 50, last_request_at: daysAgo(100), period_started_at: daysAgo(200) }, NOW, [{ messages_left: 100, expires_at: future }]);
  assert(renewed !== null && renewed.remaining === 50 && renewed.packRemaining === 100, 'a renewal gives the plan back and keeps the pack');

  // an unlimited account has no counter of bought messages
  const unlimited = messageCounter({ tier: 'premium', unlimited_usage: true, period_requests_used: 5 }, NOW, [{ messages_left: 100, expires_at: future }]);
  assert(unlimited !== null && unlimited.unlimited && unlimited.packRemaining === 0 && !unlimited.warn, 'unlimited stays unlimited');
}


// ── plural ───────────────────────────────────────────────────────────────────────────────────────────
assert(pluralMessages(1) === 'сообщение' && pluralMessages(2) === 'сообщения' && pluralMessages(5) === 'сообщений', 'plural 1 2 5');
assert(pluralMessages(11) === 'сообщений' && pluralMessages(21) === 'сообщение' && pluralMessages(22) === 'сообщения' && pluralMessages(112) === 'сообщений', 'plural 11 21 22 112');

console.log('All messageCounter cases passed.');
