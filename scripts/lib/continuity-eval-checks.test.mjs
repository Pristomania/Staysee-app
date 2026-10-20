import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROBES,
  buildBlindPairs,
  hardCheck,
  parseJudgeVerdict,
  summarizeVariants,
  topicCoverage,
} from './continuity-eval-checks.mjs';

describe('objective checks on a reply', () => {
  it('P3: fails when the corrected fact is not used (Kazan), passes with Samara or no city', () => {
    assert.equal(hardCheck('correction', 'Возьми тёплую кофту, в Казани по вечерам прохладно.').pass, false);
    assert.equal(hardCheck('correction', 'В Самаре сейчас тепло, возьми лёгкую куртку.').pass, true);
    assert.equal(hardCheck('correction', 'Возьми зарядку и подарок для сестры.').pass, true);
  });

  it('P4: fails when a heavy topic is raised without being asked, passes otherwise', () => {
    assert.equal(hardCheck('sensitive_not_raised', 'Раньше ты говорила, что чувствуешь себя никому не нужной...').pass, false);
    assert.equal(hardCheck('sensitive_not_raised', 'Попробуй выделить три главных дела на день.').pass, true);
  });

  it('P5: needs the cat\'s name and age', () => {
    assert.equal(hardCheck('recall_cat', 'Твою кошку зовут Муся, ей пять лет.').pass, true);
    assert.equal(hardCheck('recall_cat', 'Твою кошку зовут Муся.').pass, false);
    assert.equal(hardCheck('recall_cat', 'У тебя есть кошка, ей 5 лет.').pass, false);
    assert.equal(hardCheck('recall_cat', 'Мусе 5 лет, она рыжая.').pass, true, 'the name counts in any case form, and so do digits');
    assert.equal(hardCheck('recall_cat', 'Муся, пять лет.').pass, true);
  });

  it('P6: fails on a list of advice when the person only wants to vent', () => {
    const advice = 'Вот что можно сделать:\n1. Поговори с коллегой.\n2. Запиши мысли.\n3. Прогуляйся.';
    assert.equal(hardCheck('listen_first', advice).pass, false);
    assert.equal(hardCheck('listen_first', 'Мне жаль, что это случилось при всех. Расскажи, как ты это пережила?').pass, true);
  });

  it('probes that need judgement have no objective check', () => {
    for (const id of ['open_loop', 'emotional_arc', 'mother', 'thread_summary']) {
      assert.equal(hardCheck(id, 'что угодно').pass, null);
    }
  });
});

describe('what the reply remembers about the conversation (P8)', () => {
  it('counts which of the seven planted topics were mentioned', () => {
    const none = topicCoverage('Мы говорили о разном, расскажи, что важно сейчас.');
    assert.equal(none.count, 0);
    const some = topicCoverage('Ты говорила про выбор по контракту, про Мусю, про сестру Аню и про маму.');
    assert.deepEqual(some.covered.sort(), ['cat', 'mother', 'sister', 'work']);
    assert.equal(some.count, 4);
    assert.equal(topicCoverage('работа, кошка, Аня, выступление, мама, бег, выслушать').count, 7);
  });
});

describe('judge answers', () => {
  it('reads a JSON verdict, also when wrapped in text or code fences', () => {
    assert.deepEqual(parseJudgeVerdict('{"pass": true, "reason": "вернулась к контракту"}'), { pass: true, reason: 'вернулась к контракту' });
    assert.deepEqual(parseJudgeVerdict('```json\n{"pass": false, "reason": "нет"}\n```'), { pass: false, reason: 'нет' });
    assert.equal(parseJudgeVerdict('Ответ: {"pass": true, "reason": "ok"} конец').pass, true);
  });

  it('treats an unreadable verdict as unknown, never as a pass', () => {
    for (const bad of ['', 'да', '{"pass": "maybe"}', '{"reason": "x"}', 'не json']) {
      assert.equal(parseJudgeVerdict(bad).pass, null);
    }
  });
});

describe('comparing the two variants', () => {
  const sample = (probe, pass, extra = {}) => ({ probe, pass, ...extra });

  it('reports pass rates per probe and overall for each variant', () => {
    const on = [sample('correction', true), sample('correction', true), sample('correction', false), sample('recall_cat', true)];
    const off = [sample('correction', true), sample('correction', false), sample('correction', false), sample('recall_cat', true)];
    const summary = summarizeVariants({ on, off });
    assert.deepEqual(summary.perProbe.correction, { on: { passed: 2, total: 3 }, off: { passed: 1, total: 3 } });
    assert.deepEqual(summary.overall, { on: { passed: 3, total: 4 }, off: { passed: 2, total: 4 } });
  });

  it('does not count undecided samples as passes or failures', () => {
    const summary = summarizeVariants({ on: [sample('open_loop', null), sample('open_loop', true)], off: [sample('open_loop', null)] });
    assert.deepEqual(summary.perProbe.open_loop, { on: { passed: 1, total: 1 }, off: { passed: 0, total: 0 } });
    assert.equal(summary.undecided, 2);
  });
});

describe('blind pairs for a human reader', () => {
  const replies = {};
  for (const probe of PROBES) {
    replies[probe.id] = { on: [`alpha reply ${probe.id}`], off: [`beta reply ${probe.id}`] };
  }

  it('shows each pair as A/B without saying which is which, and keeps a separate key', () => {
    const { markdown, key } = buildBlindPairs(replies, ['open_loop', 'emotional_arc'], () => 0.1);
    assert.match(markdown, /Пара 1/);
    assert.match(markdown, /Пара 2/);
    assert.doesNotMatch(markdown, /пересказ|вариант|summary|\bon\b|\boff\b/i, 'nothing in the document reveals which reply is which');
    assert.match(markdown, /Ответ А/);
    assert.match(markdown, /Ответ Б/);
    assert.equal(key.length, 2);
    assert.ok(key.every((row) => ['on', 'off'].includes(row.A) && ['on', 'off'].includes(row.B) && row.A !== row.B));
  });

  it('puts the replies where the key says they are', () => {
    const { markdown, key } = buildBlindPairs(replies, ['open_loop'], () => 0.9);
    const first = key[0];
    const textFor = (variant) => `${variant === 'on' ? 'alpha' : 'beta'} reply open_loop`;
    const aText = textFor(first.A);
    const bText = textFor(first.B);
    assert.ok(markdown.indexOf(aText) < markdown.indexOf(bText), 'A is printed before B');
    assert.ok(markdown.includes(aText) && markdown.includes(bText));
  });

  it('randomises which variant is A (both orders occur)', () => {
    const orders = new Set();
    for (const value of [0.1, 0.9]) {
      orders.add(buildBlindPairs(replies, ['open_loop'], () => value).key[0].A);
    }
    assert.equal(orders.size, 2);
  });
});
