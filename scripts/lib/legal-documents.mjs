import { readFileSync } from 'node:fs';
import { PLANS, PACK, monthsPhrase } from '../../supabase/functions/_shared/plans.ts';

const ROOT = new URL('../../', import.meta.url);
const rub = value => `${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;
const rooms = count => `${count} ${count % 100 >= 11 && count % 100 <= 14 ? 'бесед' : count % 10 === 1 ? 'беседа' : count % 10 >= 2 && count % 10 <= 4 ? 'беседы' : 'бесед'}`;
const features = plan => [
  `сквозная память: ${plan.features?.crossMemory ? 'доступна' : 'недоступна'}`,
  `динамика: ${plan.features?.conversationDynamics ? 'доступна' : 'недоступна'}`,
  plan.features?.fileAttachments ? 'документы .txt, .md, .docx, .pdf и картинки' : 'вложения: недоступны',
  plan.voiceInput === 'device' || plan.voiceInput === 'ai' ? 'голосовой ввод устройства' : 'голосовой ввод: недоступен',
].join('; ');

/** Expand the tariff table before HTML, app text and consent hashes are generated. */
export function expandLegalMarkdown(markdown, plans = PLANS, pack = PACK) {
  if (!/\{\{(?:PUBLIC_TARIFFS|FREE_RENEW_PERIOD|FREE_ROOMS)\}\}/.test(markdown)) return markdown;
  const table = [
    '| Предложение | Стоимость | Сообщения | Срок | Беседы и функции |',
    '|---|---|---|---|---|',
    `| ${plans.free.label} | ${rub(plans.free.priceRub)} | ${plans.free.messages} | Возобновление через ${monthsPhrase(plans.free.renewAfterIdleMonths)} после последнего сообщения только до первой покупки | ${rooms(plans.free.maxConversations)}; ${features(plans.free)} |`,
    `| ${plans.basic.label} | ${rub(plans.basic.priceRub)} | ${plans.basic.messages} | ${plans.basic.periodDays} дней с подтверждения оплаты | ${rooms(plans.basic.maxConversations)}; ${features(plans.basic)} |`,
    `| Дополнительный пакет | ${rub(pack.priceRub)} | ${pack.messages} | ${pack.validMonths} месяцев с покупки | Не меняет тариф и его срок, не открывает дополнительные функции |`,
  ].join('\n');
  return markdown.replaceAll('{{PUBLIC_TARIFFS}}', table)
    .replaceAll('{{FREE_RENEW_PERIOD}}', monthsPhrase(plans.free.renewAfterIdleMonths))
    .replaceAll('{{FREE_ROOMS}}', rooms(plans.free.maxConversations));
}

export function readLegalMarkdown(path) {
  return expandLegalMarkdown(readFileSync(new URL(path, ROOT), 'utf8').replace(/^\uFEFF/, '').replaceAll('\r\n', '\n'));
}

export function loadLegalDocs() {
  return {
    offer: readLegalMarkdown('docs/legal/ОФЕРТА-StaySee-2026-06-28.md'),
    privacy: readLegalMarkdown('docs/legal/ПОЛИТИКА-ПД-StaySee-2026-06-28.md'),
    consent: readLegalMarkdown('docs/legal/СОГЛАСИЕ-НА-ОПД-StaySee-2026-06-28.md'),
  };
}
