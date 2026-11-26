/**
 * Live check of «вспомни» about a named time (26.11.2026). Writes a made-up conversation with back-dated messages into a __TEST__
 * conversation of the technical user, asks the real chat about June, an empty month and two ordinary facts, and prints the replies.
 * The conversation is kept for an hour (the next test run removes it). Cost: a few real replies.
 *
 *   STAYSEE_ALLOW_PROD_TESTS=1 STAYSEE_TEST_USER_ID=<technical user> node scripts/recall-period-live-check.mjs
 */
import { randomUUID } from 'node:crypto';
import { assertProdTestAllowed, restJson, withTestConversation } from './lib/prod-test-env.mjs';
import { getTechnicalUserAccessToken } from './lib/prod-test-session.mjs';

const { url, serviceKey, testUserId } = assertProdTestAllowed();
const accessToken = await getTechnicalUserAccessToken({ url, serviceKey, testUserId });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// [month-day, the person's line]. Everything is made up. September has nothing on purpose.
const STORY = [
  ['05-04', 'Кошку мою зовут Муся, она рыжая и очень упрямая.'],
  ['05-11', 'В июне хочу съездить на море, давно мечтаю, но пока не решилась.'],
  ['05-23', 'На работе тихо, разбираю старые бумаги и пью много кофе.'],
  ['06-01', 'Начался июнь, а у меня внутри тревога: на работе объявили проверку.'],
  ['06-03', 'Плохо сплю, просыпаюсь в четыре утра и прокручиваю цифры из отчёта.'],
  ['06-05', 'Начальница сказала переделать весь отчёт, я еле сдержала слёзы.'],
  ['06-08', 'Гуляла вечером у реки, впервые за неделю стало спокойнее.'],
  ['06-10', 'Опять накрыло, сердце колотится перед каждой планёркой.'],
  ['06-12', 'Позвонила подруге Оле, проговорили два часа, мне полегчало.'],
  ['06-15', 'Сдала отчёт! Чувствую пустоту и огромную усталость.'],
  ['06-17', 'Весь выходной пролежала, не хотелось ни есть, ни разговаривать.'],
  ['06-19', 'Потихоньку оживаю, купила пионы и поставила на кухне.'],
  ['06-22', 'Проверка прошла без замечаний, не верю своему счастью.'],
  ['06-25', 'Взяла отгул и поехала к тёте на дачу, там тишина и клубника.'],
  ['06-28', 'Кажется, я снова сплю нормально, и это такое облегчение.'],
  ['07-06', 'В июле жара, думаю записаться на плавание.'],
  ['07-20', 'Записалась в бассейн, хожу по средам.'],
  ['10-14', 'Осенью стало как-то грустно и хочется пораньше ложиться.'],
];

const QUESTIONS = [
  'а помнишь мое состояние в июне этого года?',
  'а что у меня было в сентябре?',
  'помнишь, как зовут мою кошку?',
  'что я говорила про море?',
  'сегодня просто устала, хочу тишины',
];

await withTestConversation({ url, serviceKey, testUserId }, `recall-period ${Date.now()}`, async ({ conversationId, headers }) => {
  const insert = async (sender, content, createdAt) => {
    await restJson(url, headers, 'messages', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ conversation_id: conversationId, user_id: testUserId, sender, role: sender === 'user' ? 'user' : 'assistant', content, ...(createdAt ? { created_at: createdAt } : {}) }),
    });
  };
  for (const [day, text] of STORY) {
    await insert('user', text, `2026-${day}T09:00:00Z`);
    await insert('ai', 'Слышу тебя. Расскажи ещё, если хочется.', `2026-${day}T09:01:00Z`);
  }
  console.log(`seeded ${STORY.length} made-up exchanges into ${conversationId}`);

  for (const question of QUESTIONS) {
    await insert('user', question);
    const response = await fetch(`${url}/functions/v1/staysee-chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, apikey: serviceKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question, conversationId, userId: testUserId, requestId: randomUUID() }),
      signal: AbortSignal.timeout(150_000),
    });
    const data = await response.json().catch(() => ({}));
    console.log(`\n>>> ${question}\n<<< [HTTP ${response.status}] ${data.content ?? JSON.stringify(data).slice(0, 300)}`);
    if (data.content) await insert('ai', data.content);
    await sleep(12_000);
  }
});
