// Live check of photo and screenshot attachments on the technical test user (never a real person).
//
//   STAYSEE_ALLOW_PROD_TESTS=1 node scripts/image-attachments-live-check.mjs <picture> [<picture> [<picture>]]
//
// With STAYSEE_LIVE_CHECK_VIA_SITE=1 the chat requests go through the site's own address (https://staysee.ru/supabase),
// i.e. through the proxy with its 4 MB limit, the way the browser sends them. Without it they go straight to Supabase.
//
// Needs the picture switch to include the test user (STAYSEE_IMAGE_ATTACHMENTS=list and
// STAYSEE_IMAGE_ATTACHMENTS_USER_IDS). Use synthetic pictures only: descriptions are printed.
// The server takes pictures only from people who gave the picture consent (user_consents, kind images); the script
// records it for the technical test user (never for anybody else), as the app does for a person.
// Sends: one picture with a question, all pictures with a question, a picture with no text, and four pictures
// (which must be refused). Then prints the recorded cost of every call in the window, to be compared with the
// OpenRouter dashboard (Activity) for the same minutes. The conversation is kept for an hour like other tests.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { assertProdTestAllowed, restJson, seedMessage, withTestConversation } from "./lib/prod-test-env.mjs";
import { getTechnicalUserAccessToken } from "./lib/prod-test-session.mjs";
import { costWindow, formatCostTable, pictureFromBytes } from "./lib/image-live-check.mjs";

const paths = process.argv.slice(2);
if (paths.length === 0 || paths.length > 3) {
  console.error("Usage: node scripts/image-attachments-live-check.mjs <picture> [<picture> [<picture>]]");
  process.exit(1);
}
const pictures = paths.map((path) => pictureFromBytes(basename(path), readFileSync(path)));

const { url, serviceKey, testUserId } = assertProdTestAllowed();
const accessToken = await getTechnicalUserAccessToken({ url, serviceKey, testUserId });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedMs = Date.now();
const chatBase = process.env.STAYSEE_LIVE_CHECK_VIA_SITE === "1" ? "https://staysee.ru/supabase" : url;
console.log(`Chat requests go ${chatBase === url ? "straight to Supabase" : "through the site proxy"}.`);

async function chat({ message, conversationId, images, tag }) {
  const started = Date.now();
  const response = await fetch(`${chatBase}/functions/v1/staysee-chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, apikey: serviceKey, "Content-Type": "application/json" },
    body: JSON.stringify({ message, conversationId, userId: testUserId, requestId: `images-${Date.now()}-${tag}`, images }),
    signal: AbortSignal.timeout(150_000),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, seconds: ((Date.now() - started) / 1000).toFixed(1) };
}

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

await withTestConversation({ url, serviceKey, testUserId }, `image-live-check ${Date.now()}`, async ({ conversationId, headers }) => {
  // The technical test user's picture consent (a test row: the hash is not a real document's).
  await restJson(url, headers, "user_consents?on_conflict=user_id,consent_type,document_version", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: JSON.stringify({
      user_id: testUserId,
      consent_type: "images",
      document_version: "images_v1",
      document_sha256: "0".repeat(64),
      user_agent: "image-attachments-live-check",
    }),
  });
  const steps = [
    { tag: "one", label: "one picture with a question", message: "Посмотри, пожалуйста, что ты видишь на этой картинке?", images: pictures.slice(0, 1) },
    ...(pictures.length > 1
      ? [{ tag: "all", label: `${pictures.length} pictures with a question`, message: "А теперь посмотри на все вместе. Что общего?", images: pictures }]
      : []),
    {
      tag: "personal",
      label: "a personal message with a screenshot of a friend's chat (memory must not take her lines as the person's facts)",
      message: "Это моя подруга Лена. Мы поссорились на прошлой неделе, мне обидно, что она считает, будто я пропадаю. Вот наша переписка.",
      images: pictures.slice(0, 1),
    },
    { tag: "only", label: "a picture with no text", message: "", images: pictures.slice(0, 1) },
    { tag: "four", label: "four pictures (must be refused)", message: "Много картинок", images: [...pictures, ...pictures, ...pictures, ...pictures].slice(0, 4) },
  ];

  for (const step of steps) {
    const { status, data, seconds } = await chat({ message: step.message, conversationId, images: step.images, tag: step.tag });
    console.log(`\n== ${step.label}: HTTP ${status} in ${seconds} s`);
    if (data.error) console.log(`   refused: ${data.error}${data.problem ? ` (${data.problem})` : ""}`);
    if (Array.isArray(data.reasons)) console.log(`   reasons: ${data.reasons.join(",")}`);
    if (typeof data.userText === "string") console.log(`   saved text: ${oneLine(data.userText).slice(0, 700)}`);
    if (typeof data.content === "string") console.log(`   reply: ${oneLine(data.content).slice(0, 400)}`);
    if (status === 200 && typeof data.content === "string") {
      // Like the website: both messages are saved after the reply, with the description lines in the person's text.
      await seedMessage(url, headers, conversationId, testUserId, "user", data.userText ?? step.message);
      await seedMessage(url, headers, conversationId, testUserId, "assistant", data.content);
    }
    await sleep(3_000);
  }

  console.log("\nWaiting for the cost records and the memory work (about 90 s)…");
  await sleep(90_000);
  const endedMs = Date.now();
  const rows = (await restJson(
    url,
    headers,
    `ai_usage_logs?user_id=eq.${testUserId}&created_at=gte.${new Date(startedMs - 1_000).toISOString()}` +
      "&select=created_at,call_kind,model,prompt_tokens,completion_tokens,cost&order=created_at",
  )) ?? [];
  console.log(`\n${formatCostTable(rows)}`);
  console.log(`\n${costWindow(startedMs, endedMs)}`);
  const items = (await restJson(url, headers, `memory_v3_dialogue_items?conversation_id=eq.${conversationId}&select=kind,claim,status,sensitivity`)) ?? [];
  console.log(`\nMemory items of this conversation now (${items.length}):`);
  for (const item of items) console.log(`   ${item.kind}/${item.status}/${item.sensitivity}: ${oneLine(item.claim).slice(0, 160)}`);
});
