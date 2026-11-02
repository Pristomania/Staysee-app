/**
 * Run: npx tsx src/lib/planCopy.cases.test.ts
 * The words the person reads about a plan: the label of a locked thing, the cards of the tariffs screen.
 */

import { PLANS } from './plans.ts';
import { LOCKED_LABEL, PACK_TITLE, PAYWALL_GO, PAYWALL_LATER, PAYMENT_STATUS_LINE, packPriceLine, packRows, priceLine, planRows } from './planCopy.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// "Without extra words": exactly these.
assert(LOCKED_LABEL === 'Доступно после оплаты', LOCKED_LABEL);
assert(PAYWALL_GO === 'Перейти к оплате', PAYWALL_GO);
assert(PAYWALL_LATER === 'Позже', PAYWALL_LATER);

assert(priceLine(PLANS.free) === '0 ₽', priceLine(PLANS.free));
assert(priceLine(PLANS.basic) === '1 990 ₽ за 30 дней', priceLine(PLANS.basic));
assert(priceLine(PLANS.premium) === '4 900 ₽ за 30 дней', priceLine(PLANS.premium));

const text = (id: 'free' | 'basic' | 'premium') => planRows(PLANS[id]).map((row) => `${row.included ? '+' : '-'} ${row.text}`);

// free: what it has is listed first, what it does not have is shown as locked, not hidden
const free = text('free');
assert(free[0] === '+ 50 сообщений, новые через 3 месяца после последнего', free[0]);
assert(free.includes('+ 1 беседа'), 'free: one conversation');
for (const locked of ['Сквозная память', 'Динамика бесед', 'Прикрепление файлов', 'Голосовой ввод']) {
  assert(free.includes(`- ${locked}`), `free: ${locked} is shown as locked`);
}

const basic = text('basic');
assert(basic[0] === '+ 400 сообщений на 30 дней', basic[0]);
assert(basic.includes('+ 3 беседы'), 'basic: three conversations');
for (const has of ['Сквозная память', 'Динамика бесед', 'Прикрепление файлов', 'Голосовой ввод']) {
  assert(basic.includes(`+ ${has}`), `basic: ${has}`);
}

const premium = text('premium');
assert(premium[0] === '+ 1 000 сообщений на 30 дней', premium[0]);
assert(premium.includes('+ 6 бесед'), 'premium: six conversations');
// The good AI voice is not promised until it is built (plans.ts AI_VOICE_BUILT).
assert(premium.includes('+ Голосовой ввод') && !premium.some((row) => /с ИИ/.test(row)), 'premium voice: no promise of the AI input yet');

assert(/Оплата скоро/.test(PAYMENT_STATUS_LINE), PAYMENT_STATUS_LINE);

// The bought messages: what they cost, when they are spent, how long they live, for whom.
assert(PACK_TITLE === 'Докупить сообщения', PACK_TITLE);
assert(packPriceLine() === '590 ₽ за 100 сообщений', packPriceLine());
const pack = packRows();
assert(pack.includes('Тратятся после сообщений вашего тарифа'), 'pack: spent after the plan');
assert(pack.includes('Действуют 12 месяцев'), 'pack: twelve months');
assert(pack.includes('Подходят к любому тарифу, и к бесплатному'), 'pack: any plan');
assert(![PACK_TITLE, packPriceLine(), ...pack].some((line) => /\$|потол|себестоим/i.test(line)), 'pack: nothing about the hidden money');

console.log('All planCopy cases passed.');
