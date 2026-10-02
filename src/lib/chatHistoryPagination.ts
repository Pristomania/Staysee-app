import type { Message } from '../types';

export interface OlderMessagePage {
  messages: Message[];
  reachedLimit: boolean;
  error: string | null;
}

export type OlderMessagePageLoader = (
  beforeIso: string,
  limit: number,
) => Promise<OlderMessagePage>;

export async function collectOlderMessageHistory(
  beforeIso: string,
  pageSize: number,
  loadPage: OlderMessagePageLoader,
): Promise<{ messages: Message[]; error: string | null }> {
  let cursor = beforeIso;
  let messages: Message[] = [];

  while (true) {
    const page = await loadPage(cursor, pageSize);
    if (page.error) return { messages: [], error: page.error };
    if (page.messages.length === 0) return { messages, error: null };

    messages = [...page.messages, ...messages];
    if (!page.reachedLimit) return { messages, error: null };

    const nextCursor = page.messages[0]?.created_at;
    if (!nextCursor || nextCursor >= cursor) {
      return { messages: [], error: 'history_cursor_did_not_advance' };
    }
    cursor = nextCursor;
  }
}

export function shouldLoadFullHistoryForSearch({
  searchOpen,
  hasMoreHistory,
  loadingMoreHistory,
}: {
  searchOpen: boolean;
  hasMoreHistory: boolean;
  loadingMoreHistory: boolean;
}): boolean {
  return searchOpen && hasMoreHistory && !loadingMoreHistory;
}
