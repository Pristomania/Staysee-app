/**
 * Run: npx tsx src/lib/messageCounter.cases.test.ts
 * The counter the person sees in the cabinet and the warning ten messages before the end. It repeats the rules the
 * database applies when a message arrives (migrations 085, 086, 088), so what is shown is what will happen.
 */

import {
  type MessageCounter,
  WARN_AT_REMAINING,
  counterLine,
  lowMessagesLine,
  messageCounter,
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
  assert(lowMessagesLine(c) === 'Сообщения закончились', lowMessagesLine(c));
  assert(counterLine(c) === 'Сообщения закончились', counterLine(c));
  // they return 3 calendar months after the last answered message
  assert(c.renewsAt?.toISOString().slice(0, 10) === '2027-02-01' || c.renewsAt?.toISOString().slice(0, 10) === '2027-01-31', `renews ${c.renewsAt?.toISOString()}`);
  assert(/через 3 месяца после последнего сообщения/.test(renewalLine(c, 'free')), renewalLine(c, 'free'));
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

// ── plural ───────────────────────────────────────────────────────────────────────────────────────────
assert(pluralMessages(1) === 'сообщение' && pluralMessages(2) === 'сообщения' && pluralMessages(5) === 'сообщений', 'plural 1 2 5');
assert(pluralMessages(11) === 'сообщений' && pluralMessages(21) === 'сообщение' && pluralMessages(22) === 'сообщения' && pluralMessages(112) === 'сообщений', 'plural 11 21 22 112');

console.log('All messageCounter cases passed.');
