/**
 * Regex parity check for technical conversation titles (UI vs cleanup).
 * Run: node scripts/lib/test-conversation-title.cases.mjs
 */

import { isTestConversationTitle } from "./test-conversation-title.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const hidden = [
  "__audit_prod__1781830342155",
  "__audit__foo",
  "__TEST__ PR3c-1",
  "audit smoke",
  "audit_prod foo",
  "prod smoke abc",
  "staging smoke run",
];

const visible = ["Сокровенное", "Приложение", "Привет"];

for (const title of hidden) {
  assert(isTestConversationTitle(title), `expected match: ${title}`);
}
for (const title of visible) {
  assert(!isTestConversationTitle(title), `expected no match: ${title}`);
}

console.log("test-conversation-title.cases.mjs — all passed");
