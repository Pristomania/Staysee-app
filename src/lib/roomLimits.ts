/** Default active conversation cap for regular users (frontend guard only). */
export const DEFAULT_MAX_ROOMS = 5;

/** Internal override — unlimited rooms for confirmed founder accounts. */
const UNLIMITED_ROOM_USER_IDS = new Set<string>([
  'cff5913e-10d2-4168-82de-ec0c0ff48929',
  'ad52b415-875a-45e9-9f6b-be4d25a2c0e0',
  '0acde6d0-2741-4992-b876-d77eab0f6d15',
]);

const UNLIMITED_FETCH_LIMIT = 100;

export function hasUnlimitedRooms(userId: string | undefined | null): boolean {
  return !!userId && UNLIMITED_ROOM_USER_IDS.has(userId);
}

export function getMaxRooms(userId: string | undefined | null): number {
  return hasUnlimitedRooms(userId) ? Infinity : DEFAULT_MAX_ROOMS;
}

/** Supabase list limit when loading active conversations on MainScreen. */
export function getConversationFetchLimit(userId: string | undefined | null): number {
  return hasUnlimitedRooms(userId) ? UNLIMITED_FETCH_LIMIT : DEFAULT_MAX_ROOMS + 1;
}

export function canCreateRoom(userId: string | undefined | null, activeCount: number): boolean {
  if (hasUnlimitedRooms(userId)) return true;
  return activeCount < DEFAULT_MAX_ROOMS;
}
