import { planFor } from './plans';

/**
 * How many conversations a person may have at the same time: the number of their plan (src/lib/plans.ts: one on the
 * free plan, three on Basic, six on Premium), or the number the database gives them by hand
 * (user_usage_tiers.max_conversations_override: the owner's accounts and the technical user). The database enforces the
 * same number (migration 087); this is the convenience that tells the person before they try. Deleting a conversation
 * opens a place for a new one. The app keeps no list of people: the one place is the database.
 */
export function getMaxRooms(tier: unknown, override?: number | null): number {
  const given = Math.floor(Number(override));
  return Number.isFinite(given) && given > 0 ? given : planFor(tier).maxConversations;
}

/** Supabase list limit when loading active conversations: room for the most any plan gives, or the person's own number. */
export function getConversationFetchLimit(maxRooms: number): number {
  return Math.max(planFor('premium').maxConversations + 4, maxRooms + 1);
}

export function canCreateRoom(activeCount: number, maxRooms: number): boolean {
  return activeCount < maxRooms;
}

const ROOMS_IN_WORDS: Record<number, string> = { 1: 'одна беседа', 3: 'три беседы', 6: 'шесть бесед' };

/** What the person reads when the places are taken: how many their plan gives and how to open one. */
export function roomLimitNotice(tier: unknown): string {
  const plan = planFor(tier);
  const count = ROOMS_IN_WORDS[plan.maxConversations] ?? `${plan.maxConversations} бесед`;
  const open = 'Чтобы начать новую, удалите одну из начатых.';
  if (plan.id === 'free') {
    return `На бесплатном тарифе доступна ${count}. ${open} Больше бесед открывается с тарифом.`;
  }
  if (plan.id === 'basic') {
    return `На тарифе «${plan.label}» доступно ${count}. ${open} Шесть бесед открывается с тарифом «Премиум».`;
  }
  return `На тарифе «${plan.label}» доступно ${count}. ${open}`;
}
