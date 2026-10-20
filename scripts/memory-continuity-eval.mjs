/**
 * Live experiment: does Stacy stay coherent over a long conversation WITHOUT the legacy
 * conversation summary? Two dedicated technical users have the same scripted conversation
 * through the REAL staysee-chat; for one of them the summary is switched off with
 * STAYSEE_LEGACY_SUMMARY_OFF. After a simulated three-day pause, the same probe messages are
 * sent (three times each) and the replies are scored with the rules in
 * scripts/lib/continuity-eval-checks.mjs, plus blind A/B pairs for a human to read.
 *
 *   STAYSEE_ALLOW_PROD_TESTS=1 \
 *   STAYSEE_TEST_USER_ID=<technical user, summary ON> \
 *   STAYSEE_TEST_USER_ID_OFF=<technical user listed in STAYSEE_LEGACY_SUMMARY_OFF> \
 *   STAYSEE_EVAL_OUT=<folder for results> \
 *   node scripts/memory-continuity-eval.mjs
 *
 * Cost: roughly 170 rubles (about 75 chat exchanges incl. their memory runs, plus a cheap judge).
 * Writes only to the two technical users' own __TEST__ conversations, which are deleted at the end.
 * Rare by design.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertExplicitTestUserId,
  assertProdTestAllowed,
  createTestConversation,
  releaseTestConversation,
  loadEnvFile,
  makeServiceHeaders,
  restJson,
  seedMessage,
} from './lib/prod-test-env.mjs';
import { getTechnicalUserAccessToken } from './lib/prod-test-session.mjs';
import { hasPendingConflictRetry } from './lib/memory-v3-prod-smoke-checks.mjs';
import {
  PROBES,
  buildBlindPairs,
  hardCheck,
  parseJudgeVerdict,
  summarizeVariants,
  topicCoverage,
} from './lib/continuity-eval-checks.mjs';

const { url, serviceKey, testUserId: onUser } = assertProdTestAllowed();
const offUser = assertExplicitTestUserId(process.env.STAYSEE_TEST_USER_ID_OFF ?? '');
if (offUser === onUser) throw new Error('STAYSEE_TEST_USER_ID and STAYSEE_TEST_USER_ID_OFF must be two different users');
const openrouterKey = loadEnvFile().OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '';
if (!openrouterKey) throw new Error('OPENROUTER_API_KEY is needed for the judge model');

const SAMPLES = Number(process.env.STAYSEE_EVAL_SAMPLES ?? 3);
const BUILD_PACE_MS = Number(process.env.STAYSEE_EVAL_PACE_SECONDS ?? 25) * 1000;
const OUT_DIR = process.env.STAYSEE_EVAL_OUT ?? 'continuity-eval-output';
const PAUSE_DAYS = 3;
const JUDGE_MODEL = 'openai/gpt-4o-mini';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const headers = makeServiceHeaders(serviceKey);

// The same person, the same threads, for both users. Several planted threads are meant to
// leave the 18-message window before the probes.
const TURNS = [
  'Привет. Меня зовут Лена, я работаю библиотекарем. Хочу поговорить о работе, я не уверена, что хочу там оставаться.',
  'В декабре у меня заканчивается контракт, и мне предложили продлить, но я не знаю. Скажу ответ после отпуска, в ноябре.',
  'Мне не нравится, когда меня сразу заваливают советами. Лучше сначала выслушай, а советы только если я попрошу.',
  'Кошка Муся, ей пять лет, рыжая, единственная, кто всегда рад меня видеть.',
  'Сестра Аня живёт в Казани, мы редко видимся, и мне без неё одиноко.',
  'Иногда мне кажется, что я никому по-настоящему не нужна. Но я не хочу сейчас это обсуждать, просто пусть будет.',
  'В пятницу у меня выступление на работе про наш книжный клуб, я очень волнуюсь, руки дрожат.',
  'Выступление прошло хорошо! Мне даже аплодировали, и я не заикалась. Я собой горжусь.',
  'Нет, я ошиблась: Аня переехала не в Казань, а в Самару, уже два года как.',
  'Мама считает, что мне стоит искать работу получше, но мне нравится моя библиотека.',
  'Утром теперь бегаю три раза в неделю, пока получается плохо, но мне нравится.',
  'Купила Мусе новую лежанку, она сразу в неё залезла.',
  'Завтра еду на дачу к подруге Оле на выходные.',
  'Спасибо, что выслушала. Пока!',
];

// Neutral small talk, scripted on both sides, pushes the planted messages out of the window.
const FILLER = [
  ['Какая сегодня погода?', 'Судя по твоим словам, прохладно. Хорошо, когда есть где согреться.'],
  ['Придумываю, что приготовить на ужин.', 'Что-нибудь простое и тёплое? Расскажи, что есть дома.'],
  ['Есть гречка и грибы.', 'Хорошее сочетание. Грибы можно обжарить с луком и добавить к гречке.'],
  ['Получилось вкусно.', 'Рада, что получилось. Приятный вечер выходит.'],
  ['Смотрела сериал, но уже не помню сюжет.', 'Бывает, когда смотришь вполглаза. Может, вернёшься к нему в другой день.'],
  ['Надо бы прибраться на выходных.', 'Начни с одного уголка, остальное пойдёт легче.'],
  ['Включила музыку, стало веселее.', 'Музыка хорошо меняет настроение. Что слушаешь?'],
  ['Старые песни, которые любила в школе.', 'Такие песни возвращают время. Приятно вспоминать.'],
  ['Пора спать, глаза слипаются.', 'Отдыхай. Тёплый чай и тишина тебе в помощь.'],
  ['Доброй ночи.', 'Доброй ночи. Выспись хорошо.'],
];

async function chat(accessToken, userId, conversationId, message, requestId) {
  const response = await fetch(`${url}/functions/v1/staysee-chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, apikey: serviceKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversationId, userId, requestId }),
    signal: AbortSignal.timeout(150_000),
  });
  const raw = await response.text();
  try {
    return { status: response.status, data: JSON.parse(raw) };
  } catch {
    return { status: response.status, data: { raw } };
  }
}

const shiftBack = (iso) => new Date(Date.parse(iso) - PAUSE_DAYS * 86_400_000).toISOString();

async function usageByKind(userId, sinceIso) {
  const rows = await restJson(
    url, headers,
    `ai_usage_logs?select=call_kind,cost&user_id=eq.${userId}&created_at=gte.${encodeURIComponent(sinceIso)}&limit=2000`,
  );
  const byKind = {};
  for (const row of rows ?? []) {
    const kind = row.call_kind ?? 'main_reply';
    byKind[kind] ??= { calls: 0, cost: 0 };
    byKind[kind].calls += 1;
    byKind[kind].cost += Number(row.cost ?? 0);
  }
  return byKind;
}

async function settle(conversationId) {
  const deadline = Date.now() + 150_000;
  let previous = '';
  let stable = 0;
  while (Date.now() < deadline) {
    const [dialogue, lifecycle] = await Promise.all([
      restJson(url, headers, `memory_v3_dialogue_runs?conversation_id=eq.${conversationId}&select=status,diagnostic_code,created_at,completed_at`),
      restJson(url, headers, `memory_v3_lifecycle_shadow_runs?conversation_id=eq.${conversationId}&select=status,diagnostic_code,created_at,completed_at`),
    ]);
    const all = [...(dialogue ?? []), ...(lifecycle ?? [])];
    const rerunPending = hasPendingConflictRetry(dialogue ?? []) || hasPendingConflictRetry(lifecycle ?? []);
    const running = all.filter((run) => run.status === 'reserved').length;
    const signature = String(all.length);
    stable = running === 0 && signature === previous ? stable + 1 : 0;
    if (stable >= 2 && !rerunPending) return;
    previous = signature;
    await sleep(6_000);
  }
}

// Memory runs are deleted together with the test conversation, so what went wrong has to be
// read first. Both run tables, failed rows only; transport_detail names a provider problem.
async function collectFailedRuns(conversationId) {
  const failures = [];
  for (const [pipeline, table] of [['dialogue', 'memory_v3_dialogue_runs'], ['lifecycle', 'memory_v3_lifecycle_shadow_runs']]) {
    for (const columns of ['diagnostic_code,transport_detail,created_at', 'diagnostic_code,created_at']) {
      try {
        const rows = await restJson(url, headers, `${table}?conversation_id=eq.${conversationId}&status=eq.failed&select=${columns}&order=created_at`);
        for (const row of rows ?? []) failures.push({ pipeline, ...row });
        break;
      } catch {
        // The column is missing on this table; retry with the shorter list.
      }
    }
  }
  return failures;
}

async function runVariant(label, userId) {
  const startedAt = new Date().toISOString();
  const accessToken = await getTechnicalUserAccessToken({ url, serviceKey, testUserId: userId });
  const { conversationId } = await createTestConversation(url, headers, userId, `continuity ${label} ${Date.now()}`);
  const log = (text) => console.log(`[${label}] ${text}`);
  try {
    for (const [index, text] of TURNS.entries()) {
      const { status, data } = await chat(accessToken, userId, conversationId, text, `cont-${label}-${startedAt}-${index}`);
      if (status !== 200 || typeof data.content !== 'string' || data.content.trim() === '') {
        throw new Error(`[${label}] build exchange ${index + 1} failed: HTTP ${status}`);
      }
      await seedMessage(url, headers, conversationId, userId, 'user', text);
      await seedMessage(url, headers, conversationId, userId, 'assistant', data.content);
      log(`built ${index + 1}/${TURNS.length}`);
      await sleep(BUILD_PACE_MS);
    }
    log('waiting for memory to settle...');
    await settle(conversationId);
    await sleep(20_000); // background summary refresh, when it is on

    const summaryRowsBeforeProbes = Object.entries(await usageByKind(userId, startedAt))
      .find(([kind]) => kind === 'legacy_conversation_summary')?.[1]?.calls ?? 0;

    for (const [user, assistant] of FILLER) {
      await seedMessage(url, headers, conversationId, userId, 'user', user);
      await seedMessage(url, headers, conversationId, userId, 'assistant', assistant);
    }

    // A person comes back after a pause: everything in the conversation is three days older.
    const messages = await restJson(url, headers, `messages?conversation_id=eq.${conversationId}&select=id,created_at&order=created_at`);
    for (const message of messages) {
      await restJson(url, headers, `messages?id=eq.${message.id}`, {
        method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ created_at: shiftBack(message.created_at) }),
      });
    }
    const [meta] = await restJson(url, headers, `conversations?id=eq.${conversationId}&select=summary_updated_at,last_message_at`);
    const metaPatch = {};
    if (meta?.summary_updated_at) metaPatch.summary_updated_at = shiftBack(meta.summary_updated_at);
    if (meta?.last_message_at) metaPatch.last_message_at = shiftBack(meta.last_message_at);
    if (Object.keys(metaPatch).length > 0) {
      await restJson(url, headers, `conversations?id=eq.${conversationId}`, {
        method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(metaPatch),
      });
    }
    log(`conversation has ${messages.length} messages, all moved ${PAUSE_DAYS} days back; probing...`);

    const replies = {};
    for (const probe of PROBES) {
      replies[probe.id] = [];
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const { status, data } = await chat(accessToken, userId, conversationId, probe.message, `cont-${label}-${startedAt}-${probe.id}-${sample}`);
        replies[probe.id].push(status === 200 && typeof data.content === 'string' ? data.content : `[HTTP ${status}]`);
        await sleep(6_000);
      }
      log(`probe ${probe.id}: ${SAMPLES} replies`);
    }
    await sleep(15_000);
    const failedRuns = await collectFailedRuns(conversationId);
    return { replies, summaryRowsBeforeProbes, usage: await usageByKind(userId, startedAt), conversationId, failedRuns };
  } finally {
    // Kept for investigation (removed after an hour by the next test run); see prod-test-env.mjs.
    await releaseTestConversation(url, headers, conversationId, { log });
  }
}

async function judge(probe, reply) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'Ты строгий и беспристрастный оценщик диалогов. Отвечай ТОЛЬКО JSON вида {"pass": true или false, "reason": "одно короткое предложение"}.' },
        { role: 'user', content: `Сообщение человека: «${probe.message}»\n\nОтвет ассистентки: «${reply}»\n\nКритерий: ${probe.rubric}` },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return { pass: null, reason: `judge HTTP ${response.status}` };
  const body = await response.json();
  return parseJudgeVerdict(body?.choices?.[0]?.message?.content ?? '');
}

console.log('Memory continuity experiment (legacy summary ON vs OFF)\n');
const [on, off] = await Promise.all([runVariant('on', onUser), runVariant('off', offUser)]);

if (off.summaryRowsBeforeProbes > 0) {
  console.error(`\nSTOP: the "off" user still had ${off.summaryRowsBeforeProbes} legacy summary call(s): the switch is not active for that user ` +
    '(is STAYSEE_LEGACY_SUMMARY_OFF set to its id and the new function deployed?). Results below are NOT a valid comparison.');
}

// Score.
const samples = { on: [], off: [] };
const coverage = { on: [], off: [] };
const details = [];
for (const [variant, run] of [['on', on], ['off', off]]) {
  for (const probe of PROBES) {
    for (const reply of run.replies[probe.id]) {
      if (probe.id === 'thread_summary') {
        coverage[variant].push(topicCoverage(reply).count);
        continue;
      }
      let { pass, note } = hardCheck(probe.id, reply);
      let reason = note;
      if (pass === null && probe.rubric) {
        const verdict = await judge(probe, reply);
        pass = verdict.pass;
        reason = verdict.reason;
      }
      samples[variant].push({ probe: probe.id, pass });
      details.push({ variant, probe: probe.id, pass, reason, reply });
    }
  }
}
const summary = summarizeVariants(samples);
const average = (values) => (values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) : 'n/a');

const lines = [];
lines.push('# Проверка связности: пересказ ВКЛЮЧЁН / ВЫКЛЮЧЕН', '');
lines.push(`Выборок на каждый вопрос: ${SAMPLES}. Пауза: ${PAUSE_DAYS} дня. Оценщик: ${JUDGE_MODEL}; остальное проверяется правилами.`, '');
lines.push('| Вопрос | Включён | Выключен |', '|---|---|---|');
for (const probe of PROBES.filter((p) => p.id !== 'thread_summary')) {
  const row = summary.perProbe[probe.id];
  lines.push(`| ${probe.id} | ${row.on.passed}/${row.on.total} | ${row.off.passed}/${row.off.total} |`);
}
lines.push(`| **Всего** | **${summary.overall.on.passed}/${summary.overall.on.total}** | **${summary.overall.off.passed}/${summary.overall.off.total}** |`, '');
lines.push(`Вопрос «что мы обсуждали» — сколько из 7 заложенных тем названо в среднем: включён ${average(coverage.on)}, выключен ${average(coverage.off)}.`, '');
lines.push('## Стоимость прогона по типам вызовов ($)', '');
for (const [label, run] of [['включён', on], ['выключен', off]]) {
  const parts = Object.entries(run.usage).map(([kind, v]) => `${kind}: ${v.calls}× $${v.cost.toFixed(3)}`);
  const total = Object.values(run.usage).reduce((sum, v) => sum + v.cost, 0);
  lines.push(`- ${label}: итого $${total.toFixed(3)} — ${parts.join('; ')}`);
}
lines.push('', '## Упавшие запуски памяти (записи удаляются вместе с беседой, поэтому сняты до очистки)', '');
for (const [label, run] of [['включён', on], ['выключен', off]]) {
  const list = run.failedRuns.map((f) => `${f.pipeline}: ${f.diagnostic_code}${f.transport_detail ? ` (${f.transport_detail})` : ''} в ${String(f.created_at).slice(11, 19)}`);
  lines.push(`- ${label}: ${list.length === 0 ? 'нет' : list.join('; ')}`);
}
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'report.md'), lines.join('\n'), 'utf8');
writeFileSync(join(OUT_DIR, 'details.json'), JSON.stringify({ summary, coverage, details, usage: { on: on.usage, off: off.usage }, failedRuns: { on: on.failedRuns, off: off.failedRuns } }, null, 2), 'utf8');

const pairProbes = ['open_loop', 'emotional_arc', 'sensitive_not_raised', 'listen_first', 'mother', 'thread_summary'];
const replies = {};
for (const probe of PROBES) replies[probe.id] = { on: on.replies[probe.id], off: off.replies[probe.id] };
const { markdown, key } = buildBlindPairs(replies, pairProbes);
writeFileSync(join(OUT_DIR, 'blind-pairs.md'), markdown, 'utf8');
writeFileSync(join(OUT_DIR, 'blind-key.json'), JSON.stringify(key, null, 2), 'utf8');

console.log(`\n${lines.join('\n')}\n\nFiles in ${OUT_DIR}: report.md, details.json, blind-pairs.md, blind-key.json`);
