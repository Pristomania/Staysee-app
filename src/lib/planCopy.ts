import { AI_VOICE_BUILT, monthsPhrase, voiceInputFor, type Plan } from './plans';
import { pluralMessages } from './messageCounter';

/** What stands on every closed thing. No extra words. */
export const LOCKED_LABEL = 'Доступно после оплаты';
export const PAYWALL_GO = 'Перейти к оплате';
export const PAYWALL_LATER = 'Позже';

/** Until the payment service is connected the button of a paid plan cannot take money, and says so. */
export const PAYMENT_STATUS_LINE = 'Оплата скоро будет доступна.';

const group = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** "0 ₽", "1 990 ₽ за 30 дней". */
export function priceLine(plan: Plan): string {
  if (plan.priceRub === 0 || plan.periodDays === null) return '0 ₽';
  return `${group(plan.priceRub)} ₽ за ${plan.periodDays} дней`;
}

function pluralRooms(count: number): string {
  const last = count % 10;
  if (count % 100 >= 11 && count % 100 <= 14) return 'бесед';
  if (last === 1) return 'беседа';
  if (last >= 2 && last <= 4) return 'беседы';
  return 'бесед';
}

export interface PlanRow {
  text: string;
  /** False: the plan does not have it. The row stays, shown as closed, so the person sees what opens with a plan. */
  included: boolean;
}

/** The rows of a plan's card: what it gives first, then the things that are open or closed. */
export function planRows(plan: Plan): PlanRow[] {
  const messages =
    plan.periodDays === null
      ? `${group(plan.messages)} ${pluralMessages(plan.messages)}, новые через ${monthsPhrase(plan.renewAfterIdleMonths ?? 3)} после последнего`
      : `${group(plan.messages)} ${pluralMessages(plan.messages)} на ${plan.periodDays} дней`;
  // The good voice input is mentioned only once it exists.
  const voiceLevel = voiceInputFor(plan.id);
  const voice = voiceLevel === 'ai' && AI_VOICE_BUILT ? 'Голосовой ввод с ИИ' : 'Голосовой ввод';
  return [
    { text: messages, included: true },
    { text: `${plan.maxConversations} ${pluralRooms(plan.maxConversations)}`, included: true },
    { text: 'Сквозная память', included: plan.features.crossMemory },
    { text: 'Динамика бесед', included: plan.features.conversationDynamics },
    { text: 'Прикрепление файлов', included: plan.features.fileAttachments },
    { text: voice, included: plan.voiceInput !== 'none' },
  ];
}
