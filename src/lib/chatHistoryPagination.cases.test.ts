/**
 * Run: npx tsx src/lib/chatHistoryPagination.cases.test.ts
 */

import type { Message } from '../types/index.ts';
import {
  collectOlderMessageHistory,
  shouldLoadFullHistoryForSearch,
  type OlderMessagePageLoader,
} from './chatHistoryPagination.ts';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function message(id: string, createdAt: string): Message {
  return {
    id,
    conversation_id: 'conversation-1',
    sender: 'user',
    content: id,
    created_at: createdAt,
  };
}

const newestBoundary = '2026-10-02T12:00:00.000Z';
const pages = [
  {
    messages: [
      message('m3', '2026-10-02T09:00:00.000Z'),
      message('m4', '2026-10-02T10:00:00.000Z'),
    ],
    reachedLimit: true,
    error: null,
  },
  {
    messages: [
      message('m1', '2026-10-02T07:00:00.000Z'),
      message('m2', '2026-10-02T08:00:00.000Z'),
    ],
    reachedLimit: true,
    error: null,
  },
  {
    messages: [],
    reachedLimit: false,
    error: null,
  },
];

const cursors: string[] = [];
const loadPage: OlderMessagePageLoader = async (beforeIso) => {
  cursors.push(beforeIso);
  return pages.shift()!;
};

const all = await collectOlderMessageHistory(newestBoundary, 2, loadPage);
assert(all.error === null, 'multi-page history should load without an error');
assert(all.messages.map((item) => item.id).join(',') === 'm1,m2,m3,m4', 'all pages stay chronological');
assert(cursors.join(',') === `${newestBoundary},2026-10-02T09:00:00.000Z,2026-10-02T07:00:00.000Z`, 'oldest row advances the cursor');

assert(
  shouldLoadFullHistoryForSearch({ searchOpen: true, hasMoreHistory: true, loadingMoreHistory: false }),
  'open search should load the remaining history',
);
assert(
  !shouldLoadFullHistoryForSearch({ searchOpen: true, hasMoreHistory: true, loadingMoreHistory: true }),
  'search waits while a scroll-driven page is loading',
);
assert(
  shouldLoadFullHistoryForSearch({ searchOpen: true, hasMoreHistory: true, loadingMoreHistory: false }),
  'search retries after the scroll-driven page finishes',
);

console.log('All chat history pagination cases passed.');
