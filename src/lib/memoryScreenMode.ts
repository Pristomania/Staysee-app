export type MemoryScreenOrigin = 'profile' | 'chat';

export interface MemoryScreenCapabilities {
  canChooseConversation: boolean;
  showAccountWideMemory: boolean;
  showProfileBulkControl: boolean;
  showConversationControl: boolean;
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
