/**
 * Conversation list hygiene — hide technical titles from UI.
 * Run: npx tsx src/lib/conversationFilters.cases.test.ts
 */

import { filterVisibleConversations, isHiddenTestConversation } from './conversationFilters';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const hidden = [
  '__audit_prod__1781830342155',
  '__audit__foo',
  '__TEST__ PR3c-1',
  'audit smoke',
  'audit_prod foo',
  'prod smoke abc',
  'staging smoke run',
  'post-fix smoke',
  'depth-arc-smoke',
  'audit-uncertainty',
];

const visible = ['Сокровенное', 'Приложение', 'Привет', 'привет мне тяжело', ''];

for (const title of hidden) {
  assert(isHiddenTestConversation(title), `expected hidden: ${title}`);
}

for (const title of visible) {
  assert(!isHiddenTestConversation(title), `expected visible: ${title}`);
}

const mixed = [
  { id: '1', title: '__audit_prod__1781830342155' },
  { id: '2', title: 'Приложение' },
  { id: '3', title: '__TEST__ x' },
  { id: '4', title: 'Сокровенное' },
];
const filtered = filterVisibleConversations(mixed);
assert(filtered.length === 2, 'filterVisibleConversations keeps only user titles');
assert(
  filtered.every((c) => c.title === 'Приложение' || c.title === 'Сокровенное'),
  'filtered titles are user-facing only',
);

console.log('conversationFilters.cases.test.ts — all passed');
