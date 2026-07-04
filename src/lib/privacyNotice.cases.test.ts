/**
 * Run: npx tsx src/lib/privacyNotice.cases.test.ts
 */

import {
  isPrivacyNoticeAccepted,
  listPrivacyNoticeEvents,
  markPrivacyNoticeAccepted,
} from './privacyNotice.ts';

const storage = new Map<string, string>();

globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => {
    storage.set(k, v);
  },
  removeItem: (k) => {
    storage.delete(k);
  },
  clear: () => storage.clear(),
  key: () => null,
  length: 0,
};

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

storage.clear();
assert(!isPrivacyNoticeAccepted('conv-a'), 'fresh conv not accepted');

markPrivacyNoticeAccepted({ userId: 'user-1', conversationId: 'conv-a' });
assert(isPrivacyNoticeAccepted('conv-a'), 'accepted after mark');

const events = listPrivacyNoticeEvents();
assert(events.length === 1, 'one ui event logged');
assert(events[0]?.event === 'privacy_notice_accepted', 'event name');
assert(events[0]?.user_id === 'user-1', 'user_id');
assert(events[0]?.conversation_id === 'conv-a', 'conversation_id');

assert(!isPrivacyNoticeAccepted('conv-b'), 'other conv unaffected');

console.log('All privacyNotice cases passed.');
