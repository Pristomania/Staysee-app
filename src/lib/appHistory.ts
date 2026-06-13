import { hasAuthCallbackInUrl } from './passwordRecovery';
import type { Screen } from '../types';

export const APP_HISTORY_TAG = 'staysee' as const;

export interface AppHistoryState {
  app: typeof APP_HISTORY_TAG;
  screen: Screen;
  conversationId: string | null;
  memoryReturnScreen: 'chat' | 'profile';
  notesReturnScreen: 'chat' | 'profile';
  dynamicsReturnScreen: 'chat' | 'profile';
  legalReturnScreen: Screen;
}

/** Keep auth callback hash intact until passwordRecovery clears it. */
export function historyUrl(): string {
  const base = window.location.pathname + window.location.search;
  const hash = window.location.hash;
  return hash ? `${base}${hash}` : base;
}

export function isAppHistoryState(value: unknown): value is AppHistoryState {
  if (!value || typeof value !== 'object') return false;
  const s = value as AppHistoryState;
  return s.app === APP_HISTORY_TAG && typeof s.screen === 'string';
}

export function pushAppHistory(state: AppHistoryState): void {
  if (typeof window === 'undefined') return;
  window.history.pushState(state, '', historyUrl());
}

export function replaceAppHistory(state: AppHistoryState): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState(state, '', historyUrl());
}

/** Skip history writes while Supabase tokens are still in the URL hash. */
export function canWriteAppHistory(): boolean {
  if (typeof window === 'undefined') return false;
  return !hasAuthCallbackInUrl();
}
