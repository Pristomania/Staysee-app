/**
 * Post-deploy prod smoke: arc A + explicit exits on live staysee-chat.
 * Run: STAYSEE_ALLOW_PROD_TESTS=1 node scripts/prod-runtime-deploy-smoke.mjs
 */

import {
  assertProdTestAllowed,
  seedMessage,
  withTestConversation,
} from "./lib/prod-test-env.mjs";

const { url, serviceKey, testUserId } = assertProdTestAllowed();

const ARC_A = [
  {
    user: "Ну это сильно по-новому.",
    assistant: "Что именно ощущается по-новому?",
  },
];

const EXIT_PHRASES = [
  "Пора бежать.",
  "Мне достаточно.",
  "Я пойду спать.",
];

const ETO_NORMALNO_RE = /это\s+нормально/i;
const OFF_RAMP_RE = /если\s+(?:захоч|хочеш)|верн(ё|е)мся\s+позже|можем\s+потом/i;
const AVAIL_RE = /я\s+(?:всегда\s+)?здесь|я\s+рядом|буду\s+рядом/i;
const QUESTION_RE = /\?/;

function analyze(text) {
  return {
    etoNormalno: ETO_NORMALNO_RE.test(text),
    offRamp: OFF_RAMP_RE.test(text),
    availability: AVAIL_RE.test(text),
    hasQuestion: QUESTION_RE.test(text),
    words: text.split(/\s+/).filter(Boolean).length,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function chat(message, conversationId, requestId) {
  const res = await fetch(`${url}/functions/v1/staysee-chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      conversationId,
      userId: testUserId,
      requestId,
    }),
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }
  return { status: res.status, data };
}

function printResult(label, user, reply, flags) {
  const pass =
    !flags.etoNormalno &&
    !flags.offRamp &&
    (label.startsWith("exit") ? !flags.hasQuestion && !flags.availability : true);
  console.log(`\n${pass ? "PASS" : "FAIL"} ${label}: ${user}`);
  console.log(`  reply: ${reply}`);
  console.log(`  flags: ${JSON.stringify(flags)}`);
  return pass;
}

const stamp = Date.now();
let failed = 0;

console.log(`Prod deploy smoke @ ${url}\n`);

// Arc A — multi-turn conversation
await withTestConversation(
  { url, serviceKey, testUserId },
  `deploy-smoke arc-a ${stamp}`,
  async ({ conversationId, headers }) => {
    for (const turn of ARC_A) {
      await seedMessage(url, headers, conversationId, testUserId, "user", turn.user);
      await sleep(150);
      await seedMessage(
        url,
        headers,
        conversationId,
        testUserId,
        "assistant",
        turn.assistant
      );
      await sleep(150);
    }

    for (const msg of ["Даже не знаю.", "Наверное да, интересно наблюдать."]) {
      const { status, data } = await chat(msg, conversationId, `arc-a-${stamp}-${msg}`);
      const reply = data.content ?? data.error ?? JSON.stringify(data);
      if (status !== 200) {
        console.log(`FAIL arc-a HTTP ${status}: ${reply}`);
        failed++;
        continue;
      }
      const flags = analyze(reply);
      const pass = printResult("arc-a", msg, reply, flags);
      if (!pass) failed++;
      await seedMessage(url, headers, conversationId, testUserId, "user", msg);
      await sleep(150);
      await seedMessage(url, headers, conversationId, testUserId, "assistant", reply);
      await sleep(150);
    }
  }
);

// Explicit exits — isolated conversations
for (const phrase of EXIT_PHRASES) {
  await withTestConversation(
    { url, serviceKey, testUserId },
    `deploy-smoke exit ${stamp} ${phrase}`,
    async ({ conversationId }) => {
      const { status, data } = await chat(
        phrase,
        conversationId,
        `exit-${stamp}-${phrase}`
      );
      const reply = data.content ?? data.error ?? JSON.stringify(data);
      if (status !== 200) {
        console.log(`FAIL exit HTTP ${status}: ${reply}`);
        failed++;
        return;
      }
      const flags = analyze(reply);
      const pass = printResult("exit", phrase, reply, flags);
      if (!pass) failed++;
    }
  );
  await sleep(500);
}

console.log(`\n=== Summary: ${failed === 0 ? "ALL PASS" : `${failed} FAIL`} ===`);
process.exit(failed === 0 ? 0 : 1);
