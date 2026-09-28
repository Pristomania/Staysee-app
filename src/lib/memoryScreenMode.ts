export type MemoryScreenOrigin = 'profile' | 'chat';

export interface MemoryScreenCapabilities {
  canChooseConversation: boolean;
  showAccountWideMemory: boolean;
  showProfileBulkControl: boolean;
  showConversationControl: boolean;
}

export function isLegacyMemoryCompatibilityEnabled(
  profile: { legacy_memory_compat_enabled?: boolean | null } | null | undefined,
): boolean {
  return profile?.legacy_memory_compat_enabled === true;
}

const PROFILE_CAPABILITIES: MemoryScreenCapabilities = Object.freeze({
  canChooseConversation: true,
  showAccountWideMemory: true,
  showProfileBulkControl: true,
  showConversationControl: false,
});

const CHAT_CAPABILITIES: MemoryScreenCapabilities = Object.freeze({
  canChooseConversation: false,
  showAccountWideMemory: false,
  showProfileBulkControl: false,
  showConversationControl: true,
});

export function resolveMemoryScreenCapabilities(
  origin: MemoryScreenOrigin,
): MemoryScreenCapabilities {
  return origin === 'chat' ? CHAT_CAPABILITIES : PROFILE_CAPABILITIES;
}
