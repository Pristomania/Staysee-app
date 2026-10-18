/**
 * Production smoke test for Memory V3 (dialogue + cross-conversation memory).
 * Run after a deploy that touches memory:
 *
 *   STAYSEE_ALLOW_PROD_TESTS=1 STAYSEE_TEST_USER_ID=<technical test user uuid> \
 *     node scripts/memory-v3-prod-smoke.mjs
 *
 * What it does: opens a __TEST__ conversation for the dedicated technical test
 * user, holds a 14-exchange conversation through the REAL staysee-chat function
 * (saving the turn afterwards, exactly as the website does), waits for the
 * background memory runs, then checks the run log and extracted items with the
 * rules in scripts/lib/memory-v3-prod-smoke-checks.mjs -- no failed or stuck
 * run, a later run reads a small window and not the whole conversation, items
 * were extracted. The test conversation and everything memory wrote for it are
 * deleted at the end, whatever the outcome.
 *
 * Cost: 14 real chat replies plus the memory model calls, roughly 30 rubles.
 * Rare by design -- never run it in a loop or on a schedule.
 */
import {
  assertProdTestAllowed,
  restJson,
  seedMessage,
  withTestConversation,
} from './lib/prod-test-env.mjs';
import { getTechnicalUserAccessToken } from './lib/prod-test-session.mjs';
import {
  checkDialogueRuns,
  checkLifecycleRuns,
  checkMemoryItems,
} from './lib/memory-v3-prod-smoke-checks.mjs';

const { url, serviceKey, testUserId } = assertProdTestAllowed();
// The chat accepts only a signed-in user's own token, never a service-role key.
const accessToken = await getTechnicalUserAccessToken({ url, serviceKey, testUserId });

const TURNS = [
  'Привет. Меня зовут Лена, мне 34 года, живу в Нижнем Новгороде.',
  'У меня есть кошка по имени Муся, ей пять лет, она рыжая.',
  'Работаю библиотекарем в детской библиотеке уже восемь лет.',
  'Сестра Аня недавно переехала в Казань, и мне без неё грустно.',
  'Мы с Аней раньше каждое воскресенье пили кофе вместе.',
  'С прошлого месяца я начала бегать по утрам, пока получается три раза в неделю.',
  'Боюсь выступать перед людьми, на работе скоро нужно рассказать про наш книжный клуб.',
  'Книжный клуб я сама придумала два года назад, ходят человек двенадцать.',
  'Муся вчера сломала мою любимую чашку, но я не смогла на неё сердиться.',
  'Хочу летом поехать к Ане в Казань на неделю, если получится взять отпуск.',
  'Мама считает, что мне пора искать другую работу, но мне нравится библиотека.',
  'Сегодня утром пробежала пять километров впервые, очень горжусь.',
  'Думаю, выступление пройдёт нормально, если я хорошо подготовлюсь заранее.',
  'Спасибо, что выслушала. Пойду пить чай с Мусей.',
];

// A person replies tens of seconds after the answer; 25s keeps memory runs from
// overlapping the way a 3-second burst does (that causes state_conflict failures
// that real usage rarely sees). STAYSEE_SMOKE_PACE_SECONDS=3 turns this into a stress test.
const PACE_SECONDS = Number(process.env.STAYSEE_SMOKE_PACE_SECONDS ?? 25);
if (!Number.isFinite(PACE_SECONDS) || PACE_SECONDS < 0 || PACE_SECONDS > 300) {
  throw new Error('STAYSEE_SMOKE_PACE_SECONDS must be a number between 0 and 300');
}
const PACE_MS = PACE_SECONDS * 1000;
const POLL_EVERY_MS = 6_000;
const SETTLE_TIMEOUT_MS = 180_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chat(message, conversationId, requestId) {
  const response = await fetch(`${url}/functions/v1/staysee-chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, apikey: serviceKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversationId, userId: testUserId, requestId }),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }
  return { status: response.status, data };
}

const RUN_COLUMNS =
  'status,diagnostic_code,message_count,user_message_count,extractor_prompt_tokens,created_at,completed_at';

async function readRuns(headers, conversationId) {
  const dialogue = await restJson(
    url, headers,
    `memory_v3_dialogue_runs?conversation_id=eq.${conversationId}&select=${RUN_COLUMNS}&order=created_at`,
  );
  const lifecycle = await restJson(
    url, headers,
    `memory_v3_lifecycle_shadow_runs?conversation_id=eq.${conversationId}&select=${RUN_COLUMNS}&order=created_at`,
  );
  return { dialogue: dialogue ?? [], lifecycle: lifecycle ?? [] };
}

// Memory runs happen in the background after each reply: wait until nothing is
// still running and no new run has appeared for two polls in a row.
async function waitForRunsToSettle(headers, conversationId) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let previous = '';
  let stableRounds = 0;
  let runs = await readRuns(headers, conversationId);
  while (Date.now() < deadline) {
    const running = [...runs.dialogue, ...runs.lifecycle].filter((run) => run.status === 'reserved').length;
    const signature = `${runs.dialogue.length}/${runs.lifecycle.length}`;
    stableRounds = running === 0 && signature === previous ? stableRounds + 1 : 0;
    if (stableRounds >= 2) break;
    previous = signature;
    await sleep(POLL_EVERY_MS);
    runs = await readRuns(headers, conversationId);
  }
  return runs;
}

const stamp = Date.now();
const problems = [];
const notes = [];
let conversationIdForCleanupCheck = null;
let headersForCleanupCheck = null;

console.log(`Memory V3 production smoke @ ${url}`);
console.log(`technical test user: ${testUserId}`);
console.log(`${TURNS.length} exchanges through the real chat, one every ${PACE_SECONDS}s; costs about 30 rubles.\n`);

await withTestConversation(
  { url, serviceKey, testUserId },
  `memory-v3-smoke ${stamp}`,
  async ({ conversationId, headers }) => {
    conversationIdForCleanupCheck = conversationId;
    headersForCleanupCheck = headers;

    for (const [index, text] of TURNS.entries()) {
      // Same order as the website: ask the chat first, then save both sides of the turn.
      const { status, data } = await chat(text, conversationId, `memory-smoke-${stamp}-${index}`);
      if (status !== 200 || typeof data.content !== 'string' || data.content.trim() === '') {
        problems.push(`chat exchange ${index + 1} failed: HTTP ${status} ${String(data.error ?? data.raw ?? '').slice(0, 120)}`);
        break;
      }
      await seedMessage(url, headers, conversationId, testUserId, 'user', text);
      await seedMessage(url, headers, conversationId, testUserId, 'assistant', data.content);
      console.log(`  ${String(index + 1).padStart(2)}/${TURNS.length}  ok  (${data.content.length} chars)`);
      await sleep(PACE_MS);
    }

    if (problems.length === 0) {
      console.log('\nwaiting for background memory runs to finish...');
      const runs = await waitForRunsToSettle(headers, conversationId);
      const messages = await restJson(url, headers, `messages?conversation_id=eq.${conversationId}&select=id`);
      const items = await restJson(
        url, headers,
        `memory_v3_dialogue_items?conversation_id=eq.${conversationId}&select=kind,status,claim`,
      );

      for (const result of [
        checkDialogueRuns(runs.dialogue, { totalMessages: (messages ?? []).length }),
        checkLifecycleRuns(runs.lifecycle, {}),
        checkMemoryItems(items ?? []),
      ]) {
        problems.push(...result.problems);
        notes.push(...result.notes);
      }
    }
  },
);

// The test must leave nothing behind (runs and identities go with the conversation).
if (conversationIdForCleanupCheck) {
  const left = await restJson(
    url, headersForCleanupCheck,
    `memory_v3_dialogue_runs?conversation_id=eq.${conversationIdForCleanupCheck}&select=id`,
  );
  if ((left ?? []).length > 0) problems.push(`cleanup left ${left.length} dialogue run(s) behind`);
}

console.log('\n--- notes');
for (const note of notes) console.log(`  ${note}`);
console.log(problems.length === 0 ? '\nPASS: Memory V3 works in production.' : '\nFAIL:');
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
