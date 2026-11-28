import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { expandLegalMarkdown, loadLegalDocs } from './lib/legal-documents.mjs';
import { buildLegalFiles } from './build-legal-content.mjs';

it('expands current tariff data in every marker without exposing premium', () => {
  const plans = {
    free: {label: 'Free fixture', priceRub: 0, messages: 7, renewAfterIdleMonths: 2, maxConversations: 1},
    basic: {label: 'Basic fixture', priceRub: 1234, messages: 83, periodDays: 14, maxConversations: 2},
    premium: {label: 'DO NOT PUBLISH', priceRub: 9999},
  };
  const htmlSource = expandLegalMarkdown('{{PUBLIC_TARIFFS}}\n{{PUBLIC_TARIFFS}}', plans, {priceRub: 321, messages: 17, validMonths: 9});
  assert.equal(htmlSource.split('Basic fixture').length - 1, 2);
  assert.ok(htmlSource.includes('1 234 ₽ | 83 | 14 дней'));
  assert.ok(htmlSource.includes('321 ₽ | 17 | 9 месяцев'));
  assert.ok(!htmlSource.includes('DO NOT PUBLISH'));
  assert.ok(!htmlSource.includes('{{'));
  assert.equal(expandLegalMarkdown('Без таблицы', plans, {}), 'Без таблицы');
});

it('hashes exactly the expanded offer the person reads, not its source template', () => {
  const docs = loadLegalDocs();
  const source = readFileSync(new URL('../docs/legal/ОФЕРТА-StaySee-2026-06-28.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const meta = JSON.parse(/export const OFFER_META = (\{[\s\S]*?\});/.exec(buildLegalFiles()['src/content/legal/offer.ts'])[1]);
  assert.equal(meta.sha256, createHash('sha256').update(docs.offer).digest('hex'));
  assert.notEqual(meta.sha256, createHash('sha256').update(source).digest('hex'));
  assert.ok(docs.offer.includes('1 990 ₽'));
  assert.ok(docs.offer.includes('590 ₽'));
});

it('uses the actual feature flags and renewal limits instead of promising disabled features', () => {
  const plans = {
    free: {label: 'Free', priceRub: 0, messages: 7, renewAfterIdleMonths: 8, maxConversations: 2, features: {}, voiceInput: 'none'},
    basic: {label: 'Basic', priceRub: 12, messages: 9, periodDays: 15, maxConversations: 1, features: {crossMemory: false, conversationDynamics: true, fileAttachments: false}, voiceInput: 'none'},
  };
  const doc = expandLegalMarkdown('{{PUBLIC_TARIFFS}}\n{{FREE_RENEW_PERIOD}}\n{{FREE_ROOMS}}', plans, {priceRub: 3, messages: 5, validMonths: 7});
  assert.ok(doc.includes('сквозная память: недоступна'));
  assert.ok(doc.includes('вложения: недоступны'));
  assert.ok(doc.includes('8 месяцев'));
  assert.ok(doc.includes('2 беседы'));
  assert.ok(!doc.includes('{{'));
});
