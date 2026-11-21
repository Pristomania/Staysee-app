/**
 * Deletes ONE test conversation (and its messages, vectors, progress rows) of a technical user, by id.
 * Refuses anything that is not titled __TEST__… or does not belong to the user given in STAYSEE_TEST_USER_ID.
 * Costs are not touched (the rows of ai_usage_logs stay).
 *
 *   STAYSEE_ALLOW_PROD_TESTS=1 STAYSEE_TEST_USER_ID=<technical user> node scripts/delete-one-test-conversation.mjs <conversation id>
 *   (started in a folder that has the project's .env)
 */
import {
  assertProdTestAllowed,
  deleteTestConversation,
  makeServiceHeaders,
  restJson,
  TEST_TITLE_PREFIX,
} from './lib/prod-test-env.mjs';

const conversationId = process.argv[2] ?? '';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
  throw new Error('usage: node scripts/delete-one-test-conversation.mjs <conversation id>');
}
const { url, serviceKey, testUserId } = assertProdTestAllowed();
const headers = makeServiceHeaders(serviceKey);

const [row] = await restJson(url, headers, `conversations?id=eq.${conversationId}&select=id,title,user_id`);
if (!row) throw new Error('no such conversation');
if (row.user_id !== testUserId) throw new Error('the conversation does not belong to STAYSEE_TEST_USER_ID: refusing');
if (!String(row.title ?? '').startsWith(TEST_TITLE_PREFIX)) throw new Error('the title does not start with __TEST__: refusing');

await deleteTestConversation(url, headers, conversationId);
console.log(`deleted test conversation ${conversationId} («${row.title}»)`);
