import { planFor } from './plans';

/**
 * How many conversations a person may have at the same time comes from the plan (src/lib/plans.ts): one on the
 * free plan, three on Basic, six on Premium. The database enforces the same number (migration 087); this is the
 * convenience that tells the person before they try. Deleting a conversation opens a place for a new one.
 */

/** Internal override — unlimited rooms for confirmed founder accounts (the database has the same override). */
const UNLIMITED_ROOM_USER_IDS = new Set<string>([
  'cff5913e-10d2-4168-82de-ec0c0ff48929',
  'ad52b415-875a-45e9-9f6b-be4d25a2c0e0',
  '0acde6d0-2741-4992-b876-d77eab0f6d15',
]);

const UNLIMITED_FETCH_LIMIT = 100;

export function hasUnlimitedRooms(userId: string | undefined | null): boolean {
  return !!userId && UNLIMITED_ROOM_USER_IDS.has(userId);
}

export function getMaxRooms(userId: string | undefined | null, tier?: unknown): number {
  return hasUnlimitedRooms(userId) ? Infinity : planFor(tier).maxConversations;
}

/** Supabase list limit when loading active conversations on MainScreen: room for the most any plan gives. */
export function getConversationFetchLimit(userId: string | undefined | null): number {
  return hasUnlimitedRooms(userId) ? UNLIMITED_FETCH_LIMIT : planFor('premium').maxConversations + 4;
}

export function canCreateRoom(userId: string | undefined | null, activeCount: number, tier?: unknown): boolean {
  if (hasUnlimitedRooms(userId)) return true;
  return activeCount < getMaxRooms(userId, tier);
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
