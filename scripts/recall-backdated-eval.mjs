/**
 * Live experiment: does Stacy remember what was said MONTHS ago, in one conversation, through the real staysee-chat?
 *
 * A made-up conversation of nine months (knowledge/recall-test-dialogue-2026-11-21/dialogue.json: 298 messages with dates from
 * January to September 2026) is written straight into the database as a test conversation of a technical user, with those past
 * dates (a message sent through the chat always gets today's date). Then the vectors of the lines are made, and the questions are sent
 * through the REAL chat; the replies are scored (by words for what must be found, by a judge model for what must NOT be invented).
 *
 *   STAYSEE_ALLOW_PROD_TESTS=1 STAYSEE_TEST_USER_ID=<technical user> node scripts/recall-backdated-eval.mjs
 *   (started in a folder that has the project's .env)
 *
 * Writes only into one conversation titled __TEST__ … of the technical user (kept for an hour, then removed by the next test run).
 * Cost: about 45 chat answers (≈2 roubles each) plus the vectors and a cheap judge; the calls outside the app are written into the cost log.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  assertProdTestAllowed,
  createTestConversation,
  loadEnvFile,
  makeServiceHeaders,
  releaseTestConversation,
  restJson,
  seedMessage,
} from './lib/prod-test-env.mjs';
import { getTechnicalUserAccessToken } from './lib/prod-test-session.mjs';
import { wrapForOffAppUsage } from './lib/off-app-usage-log.mjs';

const DIALOGUE = process.env.RECALL_DIALOGUE ?? 'D:/Project/GPT JARVIS/knowledge/recall-test-dialogue-2026-11-21/dialogue.json';
const OUT_DIR = process.env.RECALL_OUT ?? 'D:/Project/GPT JARVIS/knowledge/recall-backdated-eval-2026-11-21';
const PACE_MS = Number(process.env.RECALL_PACE_SECONDS ?? 8) * 1000;
// An open model that stands on Cloud.ru (144 roubles per 1M tokens, about 0.65 roubles a verdict). On 21.11.2026 it gave the same verdict as
// Claude Sonnet 4.5 (a partner model of Cloud.ru, 483 roubles, not hosted in Russia) on 47 of 47 answers.
const JUDGE_MODEL = process.env.RECALL_JUDGE_MODEL ?? 'moonshotai/Kimi-K2.6';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 0 = the question and the answer are NOT written into the conversation, so every question meets the same clean history
// (a person asks one question, not forty in a row; earlier "не вижу" answers in the history make the next ones copy them).
const SAVE_TURNS = (process.env.RECALL_SAVE_TURNS ?? '1') !== '0';

// The home connection drops now and then (a connect timeout, nothing was sent yet): wait and repeat instead of losing the run.
{
  const baseFetch = globalThis.fetch.bind(globalThis);
  const SAFE_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);
  globalThis.fetch = async (input, init) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await baseFetch(input, init);
      } catch (error) {
        const code = error?.cause?.code ?? error?.code;
        const idempotent = ['GET', 'HEAD', undefined].includes(String(init?.method ?? 'GET').toUpperCase());
        if (attempt >= 6 || !(SAFE_CODES.has(code) || idempotent)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 3_000 * attempt));
      }
    }
  };
}

const env = loadEnvFile();
const { url, serviceKey, testUserId } = assertProdTestAllowed(env);
const openrouterKey = env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '';
if (!openrouterKey) throw new Error('OPENROUTER_API_KEY is needed (vectors of the lines)');
if (!env.CLOUDRU_API_KEY) throw new Error('CLOUDRU_API_KEY is needed (the judge)');
const headers = makeServiceHeaders(serviceKey);
const log = (text) => console.log(text);

const data = JSON.parse(readFileSync(DIALOGUE, 'utf8'));
const messages = data.messages;
const queries = data.queries;

// What the answer must contain (any of the words) for a question that has an answer, by the tag of the line that answers it.
const EXPECT = {
  sister: ['Ксени'], sister2: ['Ксени'], allergy: ['пенициллин'], bday: ['14 марта', '14.03'], mom_ny: ['стол', 'салат', 'скатерт', 'пора уметь', 'уехала', 'на день раньше'],
  baikal: ['Байкал'], job: ['Ирин', 'заявлен', 'увол', 'нов'], grandma: ['пирог', 'капуст', 'рецепт'], run: ['десят', '10', 'километр', 'бег'],
  thyroid: ['щитовидн', 'витамин', 'анализ'], sleep: ['сплю', 'спал', 'мелисс', 'бессонн', 'засып', 'разбит', 'голова не отключ', 'до трёх'], partner: ['Андре', 'переезд', 'Питер', 'Петербург'],
  lena_fight: ['Лен', 'день рождения', 'забыл'], meat: ['мяс'], meat2: ['мяс'], dentist: ['15:30', '15.30', 'стоматолог', 'пятниц'], age: ['31'], city: ['Тул'],
  lefty: ['лев'], cat: ['Муся', 'Муся'], profession: ['дизайнер'], fav_color: ['зелён', 'зелен'], fear_heights: ['высот'], yoga: ['йог'],
};
const EXPECT_BY_QUERY = { 'как звали мою начальницу на старой работе?': ['Ирина Павловна', 'Ирин'] };

// Ordinary messages with words like «раньше», «тогда»: not requests to remember; nothing may be invented about what was "said earlier".
const TRAPS = [
  'И тогда я решила, что хватит, и ушла с работы.',
  'Раньше я такого не чувствовала.',
  'Помнишь, как в детстве мы с сестрой строили шалаш? Это было лучшее лето.',
  'Посмотри, какая красивая погода за окном!',
  'Продолжим завтра, сегодня я очень устала.',
  'Мне кажется, я раньше была смелее.',
];

function chatFetcher(accessToken) {
  return async function chat(message, conversationId, requestId) {
    const started = Date.now();
    let response;
    let raw = '';
    try {
      response = await fetch(`${url}/functions/v1/staysee-chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, apikey: serviceKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, conversationId, userId: testUserId, requestId }),
        signal: AbortSignal.timeout(150_000),
      });
      raw = await response.text();
    } catch (error) {
      return { status: 0, content: '', ms: Date.now() - started, error: error?.cause?.code ?? error?.message ?? 'network' };
    }
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw };
    }
    return { status: response.status, content: typeof body.content === 'string' ? body.content : '', ms: Date.now() - started };
  };
}

const judgeFetch = wrapForOffAppUsage(globalThis.fetch.bind(globalThis), 'recall-backdated-judge', { env });

async function judgeFull(kind, message, reply) {
  const hint = kind.startsWith('pos') ? 'В переписке ответ на этот вопрос ЕСТЬ.' : kind === 'trap' ? 'Это обычная реплика человека, не просьба вспомнить.' : 'Про это в переписке НИЧЕГО нет.';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await judgeFetch('https://foundation-models.api.cloud.ru/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CLOUDRU_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: JUDGE_MODEL, temperature: 0, max_tokens: 600, chat_template_kwargs: { thinking: false }, messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: `РЕПЛИКИ ЧЕЛОВЕКА В ПЕРЕПИСКЕ:\n${TRUTH}\n\n${hint}\nСООБЩЕНИЕ ЧЕЛОВЕКА: ${message}\n\nОТВЕТ АССИСТЕНТКИ: ${reply}` }] }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const m = String(body?.choices?.[0]?.message?.content ?? '').match(/\{[\s\S]*\}/);
      const p = m ? JSON.parse(m[0]) : null;
      if (p && typeof p.invented === 'boolean' && typeof p.correct === 'boolean') return { invented: p.invented, correct: p.correct, reason: String(p.reason ?? '') };
    } catch { /* again */ }
    await sleep(2_000 * attempt);
  }
  return { invented: null, correct: null, reason: 'судья недоступен' };
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const formatDay = (iso) => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
// The whole correspondence of the person (with the day each line was written) is the source of truth for the judge.
const TRUTH = messages.filter((m) => m.sender === 'user').map((m) => `[${formatDay(m.created_at)}] ${m.content.replace(/\s+/g, ' ')}`).join('\n');
const JUDGE_SYSTEM = `Ты строгий, внимательный и беспристрастный проверяющий ответов ассистентки на вопросы человека о том, что он говорил раньше в переписке.
Тебе дают ВСЕ реплики человека из переписки (единственный источник правды; в квадратных скобках день, когда реплика написана, а не обязательно день события), вопрос человека и ответ ассистентки.
Оцени ДВЕ вещи.
1) invented: есть ли в ответе хотя бы одна конкретная подробность (имя, кличка, название, дата, число, место, человек, событие, причина), которой НЕТ в репликах и которая из них не следует. Дословная цитата реплики, пересказ своими словами, ссылка на день написания реплики из скобок и вычисление дня недели из даты НЕ выдумка. Фраза «в переписке этого не вижу», просьба напомнить и вопрос НЕ выдумка.
2) correct: для вопроса, ответ на который в переписке ЕСТЬ: названа ли суть верно. Если ассистентка честно сказала «не вижу», хотя ответ в переписке есть, correct=false (но invented=false). Для вопроса, ответа на который в переписке НЕТ (или обычной реплики): correct=true, если ассистентка не выдаёт ничего за сказанное человеком.
Верни ТОЛЬКО JSON: {"invented": true или false, "correct": true или false, "reason": "одна короткая фраза"}.`;

// ---------- 1. the conversation with the past dates
log('1. создаю тестовую беседу и записываю сообщения с прошлыми датами');
const { conversationId, title } = await createTestConversation(url, headers, testUserId, `recall-backdated ${new Date().toISOString().slice(0, 16)}`);
for (let i = 0; i < messages.length; i += 100) {
  const rows = messages.slice(i, i + 100).map((m) => ({
    conversation_id: conversationId,
    user_id: testUserId,
    sender: m.sender === 'user' ? 'user' : 'ai',
    role: m.sender === 'user' ? 'user' : 'assistant',
    content: m.content,
    created_at: m.created_at,
  }));
  await restJson(url, headers, 'messages', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
}
const lastDate = messages[messages.length - 1].created_at;
await restJson(url, headers, `conversations?id=eq.${conversationId}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ last_message_at: lastDate }) });
const [check] = await restJson(url, headers, `messages?conversation_id=eq.${conversationId}&select=created_at&order=created_at.asc&limit=1`);
log(`   беседа «${title}» (${conversationId}), ${messages.length} сообщений, самое раннее: ${check.created_at}, самое позднее: ${lastDate}`);

try {
  // ---------- 2. the vectors of the lines (the same code the chat runs), the cost is written down
  log('2. делаю отпечатки реплик (bge-m3, как в приложении)');
  const { ensureConversationEmbeddings } = await import('../supabase/functions/_shared/messageEmbeddings.ts');
  const rest = async (path, init) => fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init?.prefer ? { Prefer: init.prefer } : {}) } });
  const svc = {
    async rpc(name, args) {
      const res = await rest(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
      const text = await res.text();
      return res.ok ? { data: text ? JSON.parse(text) : null, error: null } : { data: null, error: { message: `HTTP ${res.status} ${text.slice(0, 200)}` } };
    },
    from(table) {
      return {
        async upsert(rows, options) {
          const res = await rest(`${table}?on_conflict=${options.onConflict}`, { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify(rows) });
          return res.ok ? { error: null } : { error: { message: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}` } };
        },
      };
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = wrapForOffAppUsage(realFetch.bind(globalThis), 'recall-backdated-vectors', { env });
  let embeddedTotal = 0;
  try {
    for (let round = 0; round < 12; round += 1) {
      const n = await ensureConversationEmbeddings(svc, {
        conversationId, userId: testUserId, maxMessages: 80,
        embedConfig: { apiKey: openrouterKey, extraHeaders: { 'HTTP-Referer': 'https://staysee.app', 'X-Title': 'StaySee AI' } },
      });
      embeddedTotal += n;
      if (n === 0) break;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  const [{ count }] = await restJson(url, headers, `message_embeddings?conversation_id=eq.${conversationId}&embedding_model=eq.baai%2Fbge-m3&select=count`);
  log(`   отпечатков сделано: ${embeddedTotal}; в базе для беседы: ${count} из ${messages.length}`);

  // ---------- 3. the questions through the real chat
  log('3. задаю вопросы через настоящий чат');
  const accessToken = await getTechnicalUserAccessToken({ url, serviceKey, testUserId });
  const chat = chatFetcher(accessToken);
  const startedAt = new Date().toISOString();
  const results = [];

  const order = [
    ...queries.filter((q) => q.kind === 'pos_direct'),
    ...queries.filter((q) => q.kind === 'pos_paraphrase'),
    ...queries.filter((q) => q.kind === 'neg' || q.kind === 'neg_hard'),
  ];
  const jobs = [...order.map((q) => ({ kind: q.kind, message: q.q, rel: q.rel })), ...TRAPS.map((t) => ({ kind: 'trap', message: t, rel: [] }))];

  for (const [index, job] of jobs.entries()) {
    let reply = await chat(job.message, conversationId, `recall-bd-${startedAt}-${index}`);
    for (let again = 1; again <= 2 && (reply.status !== 200 || !reply.content); again += 1) {
      log(`   (ответа нет: HTTP ${reply.status}${reply.error ? ' ' + reply.error : ''}; пробую ещё раз через 20 с)`);
      await sleep(20_000);
      reply = await chat(job.message, conversationId, `recall-bd-${startedAt}-${index}-again${again}`);
    }
    // The website saves the turn after the reply; the function waits for the message (memory), so the turn is saved here too.
    if (SAVE_TURNS && reply.status === 200 && reply.content) {
      await seedMessage(url, headers, conversationId, testUserId, 'user', job.message);
      await seedMessage(url, headers, conversationId, testUserId, 'assistant', reply.content);
    }
    let verdict;
    if (reply.status !== 200 || !reply.content) {
      verdict = { pass: false, how: 'ошибка', reason: `HTTP ${reply.status}` };
    } else {
      const j = await judgeFull(job.kind, job.message, reply.content);
      const words = job.kind.startsWith('pos') ? (EXPECT_BY_QUERY[job.message] ?? job.rel.flatMap((tag) => EXPECT[tag] ?? [])) : [];
      const hit = words.find((w) => reply.content.toLowerCase().includes(w.toLowerCase()));
      verdict = {
        pass: j.invented === null ? null : j.correct === true && j.invented === false,
        how: 'судья (вся переписка)', invented: j.invented,
        reason: `${j.correct === true ? 'верно' : 'не верно или «не вижу»'}${j.invented ? '; ВЫДУМКА' : ''}: ${j.reason}${job.kind.startsWith('pos') ? (hit ? ` [слово «${hit}» есть]` : ' [ключевых слов нет]') : ''}`,
      };
    }
    results.push({ kind: job.kind, message: job.message, reply: reply.content, ms: reply.ms, status: reply.status, ...verdict });
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'partial.json'), JSON.stringify({ conversationId, results }, null, 1), 'utf8');
    log(`   ${String(index + 1).padStart(2)}/${jobs.length} [${job.kind}] ${verdict.pass === true ? 'OK ' : verdict.pass === false ? 'НЕТ' : '?? '} ${reply.ms} мс  «${job.message.slice(0, 50)}»`);
    await sleep(PACE_MS);
  }

  // ---------- 4. what the log says
  await sleep(15_000);
  const usage = await restJson(url, headers, `ai_usage_logs?conversation_id=eq.${conversationId}&select=call_kind,model,latency_ms,cost,error_code&limit=2000`);
  const byKind = {};
  for (const row of usage) {
    const key = `${row.call_kind ?? 'chat'} | ${row.model}`;
    const e = (byKind[key] ??= { calls: 0, ms: 0, cost: 0, errors: 0 });
    e.calls += 1;
    e.ms += row.latency_ms ?? 0;
    e.cost += Number(row.cost ?? 0);
    if (row.error_code) e.errors += 1;
  }

  // ---------- 5. the report
  mkdirSync(OUT_DIR, { recursive: true });
  const lines = [];
  lines.push(`# Поиск «вспомни» на данных с прошлыми датами (живой прогон, ${new Date().toISOString().slice(0, 16)} UTC)`);
  lines.push('');
  lines.push(`Беседа «${title}» (${conversationId}) технического пользователя, ${messages.length} сообщений с датами ${check.created_at.slice(0, 10)} — ${lastDate.slice(0, 10)}, отпечатков в базе: ${count}.`);
  lines.push('Вопросы идут через настоящий чат; ответ засчитан, если нужный факт назван (по словам), а на вопросы без ответа и на «ловушки» нет выдумки (по оценке модели-судьи).');
  lines.push('');
  const groups = [['pos_direct', 'Прямые (со словами «вспомни», «помнишь»)'], ['pos_paraphrase', 'Другими словами, без слов-флажков'], ['neg', 'Пустые (в беседе этого нет)'], ['neg_hard', 'Пустые, но близкие по теме'], ['trap', 'Ловушки (обычный рассказ со словами «раньше», «тогда», «помнишь»)']];
  for (const [kind, name] of groups) {
    const rows = results.filter((r) => r.kind === kind);
    if (!rows.length) continue;
    lines.push(`## ${name}: прошло ${rows.filter((r) => r.pass === true).length} из ${rows.length}`);
    lines.push('');
    lines.push('| Итог | Вопрос | Ответ Стейси (начало) | Основание | мс |');
    lines.push('|---|---|---|---|---|');
    for (const r of rows) {
      const cell = (s) => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 260);
      lines.push(`| ${r.pass === true ? 'да' : r.pass === false ? '**нет**' : '?'} | ${cell(r.message)} | ${cell(r.reply)} | ${cell(r.reason ?? '')} | ${r.ms} |`);
    }
    lines.push('');
  }
  const inventedRows = results.filter((r) => r.invented === true || (r.kind.startsWith('neg') || r.kind === 'trap') && r.pass === false);
  lines.push(`## Выдумки (подробности, которых не было): ${inventedRows.length} из ${results.length}`);
  lines.push('');
  lines.push('## Журнал расходов беседы (вызовы, среднее время, расход, ошибки)');
  lines.push('');
  lines.push('| Вид | Вызовов | Среднее время, мс | Расход, $ | Ошибок |');
  lines.push('|---|---|---|---|---|');
  for (const [key, e] of Object.entries(byKind).sort()) lines.push(`| ${key} | ${e.calls} | ${Math.round(e.ms / e.calls)} | ${e.cost.toFixed(5)} | ${e.errors} |`);
  lines.push('');
  writeFileSync(join(OUT_DIR, 'report.md'), lines.join('\n'), 'utf8');
  writeFileSync(join(OUT_DIR, 'details.json'), JSON.stringify({ conversationId, title, results, byKind }, null, 1), 'utf8');
  const passed = results.filter((r) => r.pass === true).length;
  log(`\nГОТОВО: прошло ${passed} из ${results.length}. Отчёт: ${join(OUT_DIR, 'report.md')}`);
} finally {
  // Kept for an hour for investigation; removed by the next test run (see prod-test-env.mjs).
  await releaseTestConversation(url, headers, conversationId, { log });
}
