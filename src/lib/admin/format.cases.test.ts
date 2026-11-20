/**
 * How the admin panel shows money, time and cost classes (src/lib/admin/format.ts).
 * Run: npx tsx src/lib/admin/format.cases.test.ts
 */

import { costClassTitle, formatMoscow, formatUsd } from './format.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  assert(actual === expected, `${msg}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

// Money: a comma, two digits, a dollar sign; a thousands separator; "—" when there is nothing to show.
eq(formatUsd(1.94), '1,94 $', 'cents');
eq(formatUsd(0), '0,00 $', 'zero');
eq(formatUsd(7.9), '7,90 $', 'one digit after the comma is padded');
eq(formatUsd(0.004), '0,00 $', 'under a cent');
eq(formatUsd(1234.5).split(String.fromCharCode(160)).join(' '), '1 234,50 $', 'thousands (a no-break space is the separator)');
eq(formatUsd('2.5' as unknown as number), '2,50 $', 'a number that came as text from the database');
eq(formatUsd(null), '—', 'null');
eq(formatUsd(undefined), '—', 'undefined');
eq(formatUsd(Number.NaN), '—', 'NaN');
eq(formatUsd(Number.POSITIVE_INFINITY), '—', 'infinity');
console.log('✓ money');

// Time: Moscow time, day.month.year hour:minute.
eq(formatMoscow('2026-11-20T01:21:00Z'), '20.11.2026 04:21', 'Moscow is UTC+3');
eq(formatMoscow('2026-11-19T22:30:00+00:00'), '20.11.2026 01:30', 'the day changes in Moscow');
eq(formatMoscow('2026-07-01T00:00:00.000Z'), '01.07.2026 03:00', 'summer, still UTC+3');
eq(formatMoscow(null), '—', 'null');
eq(formatMoscow(undefined), '—', 'undefined');
eq(formatMoscow(''), '—', 'empty');
eq(formatMoscow('garbage'), '—', 'garbage');
console.log('✓ time');

eq(costClassTitle('user'), 'Пользовательские', 'user class');
eq(costClassTitle('technical'), 'Технические', 'technical class');
console.log('✓ cost classes');

console.log('All admin format cases passed.');
