/**
 * What the admin panel shows for a row, a page and a label change (src/lib/admin/adminViewModels.ts).
 * Run: npx tsx src/lib/admin/adminViewModels.cases.test.ts
 */

import { costsForClass, describeAdminError, kindsForClass, labelChangeMessage, pageInfo, splitCostTotals, toPersonRow } from './adminViewModels.ts';
import { costKindTitle } from './format.ts';
import type { AdminCosts, AdminPersonRow } from './adminTypes.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function same(actual: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

const row: AdminPersonRow = {
  user_id: '11111111-1111-4111-8111-111111111111',
  email: 'anna@example.invalid',
  registered_at: '2026-11-11T00:57:00Z',
  last_sign_in_at: '2026-11-20T01:21:00Z',
  label_key: 'person',
  label_title: 'Человек',
  tier: 'premium',
  conversations: 5,
  user_messages: 86,
  cost_user_usd: 1.94,
  cost_technical_usd: '0.5',
};

// ── a row of the people table ───────────────────────────────────────────────────────────────────────────
same(
  toPersonRow(row),
  {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'anna@example.invalid',
    label: 'Человек',
    labelKey: 'person',
    tier: 'premium',
    lastLogin: '20.11.2026 04:21',
    registered: '11.11.2026 03:57',
    userCost: '1,94 $',
    technicalCost: '0,50 $',
    conversations: 5,
    messages: 86,
  },
  'a full row',
);
{
  const empty = toPersonRow({ ...row, last_sign_in_at: null, tier: null, conversations: 0, user_messages: 0, cost_user_usd: 0, cost_technical_usd: 0 });
  assert(empty.lastLogin === '—', 'a person who never signed in shows a dash');
  assert(empty.tier === '—', 'no tier shows a dash');
  assert(empty.userCost === '0,00 $' && empty.technicalCost === '0,00 $', 'zero costs are 0,00 $');
  assert(empty.conversations === 0 && empty.messages === 0, 'zero counts stay zero');
}
console.log('✓ a row of the people table');

// ── the two cost cards ──────────────────────────────────────────────────────────────────────────────────
same(
  splitCostTotals({ user_usd: 3, technical_usd: 1 }),
  [{ title: 'Пользовательские', value: '3,00 $' }, { title: 'Технические', value: '1,00 $' }],
  'user first, technical second',
);
same(
  splitCostTotals({ user_usd: '7.91', technical_usd: 0 }),
  [{ title: 'Пользовательские', value: '7,91 $' }, { title: 'Технические', value: '0,00 $' }],
  'numbers that came as text',
);
console.log('✓ the two cost cards');

// ── plain words for what a call was for ─────────────────────────────────────────────────────────────────
same(costKindTitle('reply'), 'Ответы Стейси', 'the reply');
same(costKindTitle('memory_dialogue_extractor'), 'Память: выделение фактов из беседы', 'memory extractor');
same(costKindTitle('memory_dialogue_reconciler'), 'Память: сверка фактов', 'memory reconciler');
same(costKindTitle('legacy_conversation_summary'), 'Пересказ беседы (старая память)', 'the old summary');
same(costKindTitle('image_description'), 'Описание картинок', 'images');
same(costKindTitle('embedding'), 'Векторы для поиска по памяти', 'embeddings');
same(costKindTitle('a_kind_nobody_named_yet'), 'a_kind_nobody_named_yet', 'an unknown kind is shown as it is, never hidden');
same(costKindTitle('offapp:stacy-eval'), 'Вне приложения: stacy-eval', 'a call made outside the app says so and keeps what it was for');
console.log('✓ plain words for what a call was for');

// ── costs as two tabs: only the class that was asked for ────────────────────────────────────────────────
const costs: AdminCosts = {
  totals: { user_usd: '3.5', technical_usd: 24 },
  by_day: [
    { day: '2026-11-18', cost_class: 'user', usd: 1 },
    { day: '2026-11-19', cost_class: 'user', usd: '2.5' },
    { day: '2026-11-19', cost_class: 'technical', usd: 24 },
  ],
  by_kind: [
    { cost_class: 'technical', kind: 'reply', calls: 10, usd: 24 },
    { cost_class: 'user', kind: 'reply', calls: 7, usd: 3 },
    { cost_class: 'user', kind: 'memory_dialogue_extractor', calls: 2, usd: '0.5' },
  ],
  by_person: [
    { user_id: 'a', email: 'anna@example.invalid', who: 'account', cost_class: 'technical', usd: 24 },
    { user_id: 'b', email: null, who: 'account', cost_class: 'user', usd: 3.5 },
    { user_id: null, email: null, who: 'deleted', cost_class: 'user', usd: 1.5 },
    { user_id: null, email: null, who: 'deleted', cost_class: 'technical', usd: 8 },
    { user_id: null, email: null, who: 'off_app', cost_class: 'technical', usd: 4.25 },
  ],
};
same(
  costsForClass(costs, 'user'),
  {
    total: '3,50 $',
    empty: false,
    kinds: [
      { kind: 'Ответы Стейси', calls: 7, usd: '3,00 $' },
      { kind: 'Память: выделение фактов из беседы', calls: 2, usd: '0,50 $' },
    ],
    days: [
      { day: '19.11.2026', usd: '2,50 $' },
      { day: '18.11.2026', usd: '1,00 $' },
    ],
    people: [
      { email: '—', usd: '3,50 $' },
      { email: 'Удалённые аккаунты', usd: '1,50 $' },
    ],
  },
  'the user tab holds user rows only, newest day first',
);
same(
  costsForClass(costs, 'technical'),
  {
    total: '24,00 $',
    empty: false,
    kinds: [{ kind: 'Ответы Стейси', calls: 10, usd: '24,00 $' }],
    days: [{ day: '19.11.2026', usd: '24,00 $' }],
    people: [
      { email: 'anna@example.invalid', usd: '24,00 $' },
      { email: 'Удалённые аккаунты', usd: '8,00 $' },
      { email: 'Вне приложения (проверки и тесты)', usd: '4,25 $' },
    ],
  },
  'the technical tab holds technical rows only: the deleted accounts and the calls made outside the app are lines of their own',
);
same(
  costsForClass({ totals: { user_usd: 0, technical_usd: 0 }, by_day: [], by_kind: [], by_person: [] }, 'technical'),
  { total: '0,00 $', empty: true, kinds: [], days: [], people: [] },
  'a class with nothing in it says so',
);
same(
  kindsForClass([{ cost_class: 'technical', kind: 'reply', calls: 1, usd: 2 }, { cost_class: 'user', kind: 'image_description', calls: 3, usd: 0.07 }], 'user'),
  [{ kind: 'Описание картинок', calls: 3, usd: '0,07 $' }],
  'the same split for one person',
);
console.log('✓ costs as two tabs');

// ── pages ───────────────────────────────────────────────────────────────────────────────────────────────
same(pageInfo(120, 50, 0), { from: 1, to: 50, hasPrev: false, hasNext: true }, 'the first page');
same(pageInfo(120, 50, 50), { from: 51, to: 100, hasPrev: true, hasNext: true }, 'the middle page');
same(pageInfo(120, 50, 100), { from: 101, to: 120, hasPrev: true, hasNext: false }, 'the last page');
same(pageInfo(50, 50, 0), { from: 1, to: 50, hasPrev: false, hasNext: false }, 'exactly one full page');
same(pageInfo(0, 50, 0), { from: 0, to: 0, hasPrev: false, hasNext: false }, 'nothing at all');
same(pageInfo(12, 50, 1000), { from: 0, to: 0, hasPrev: true, hasNext: false }, 'an offset beyond the end');
console.log('✓ pages');

// ── the question before a label is changed ──────────────────────────────────────────────────────────────
assert(
  labelChangeMessage('anna@example.invalid', 'Человек', 'Тестовый') === 'Поменять метку у anna@example.invalid: Человек → Тестовый?',
  'the confirmation text names the person and both labels',
);
console.log('✓ the confirmation text');

// ── the words for a failure ─────────────────────────────────────────────────────────────────────────────
assert(describeAdminError('network') === 'Нет связи с сервером.', 'no network');
for (const reason of ['password_stale', 'no_session', 'invalid_token']) {
  assert(describeAdminError(reason) === 'Нужно войти заново.', reason + ' asks to sign in again');
}
assert(describeAdminError('unknown_label') === 'Такой метки нет.', 'unknown label');
assert(describeAdminError('unknown_user') === 'Такого человека нет.', 'unknown person');
assert(describeAdminError('bad_request') === 'Запрос не принят.', 'bad request');
assert(describeAdminError('something_new') === 'Не получилось. Попробуй ещё раз.', 'anything else');
assert(!/not_admin|403/.test(describeAdminError('not_admin')), 'a refusal for a non-admin names nothing technical');
console.log('✓ the words for a failure');

console.log('All adminViewModels cases passed.');
