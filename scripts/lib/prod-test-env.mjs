/**
 * Shared guard + helpers for prod smoke / audit scripts.
 * Never create conversations on real user profiles without STAYSEE_TEST_USER_ID.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const TEST_TITLE_PREFIX = "__TEST__";

/** Titles matching these patterns are eligible for automated cleanup. */
export const TEST_CONVERSATION_TITLE_RE =
  /^(?:__TEST__|post-fix smoke|audit(?:\s|[-_])|prod smoke|exact-test|depth-arc-smoke|audit-uncertainty)/i;

export function loadEnvFile(cwd = process.cwd()) {
  const vars = {};
  try {
    for (const line of readFileSync(resolve(cwd, ".env"), "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  } catch {
    /* optional */
  }
  return vars;
}

export function getSupabaseUrl(env = loadEnvFile()) {
  return (
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    env.SUPABASE_URL ??
    env.VITE_SUPABASE_URL ??
    ""
  ).replace(/\/$/, "");
}

export function getServiceKey(env = loadEnvFile()) {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? "";
}

export function isProdSupabaseUrl(url) {
  return /supabase\.co/i.test(url) && !/localhost|127\.0\.0\.1/i.test(url);
}

/**
 * Call at script start. Fails fast if prod tests are not explicitly allowed.
 */
export function assertProdTestAllowed(env = loadEnvFile()) {
  const url = getSupabaseUrl(env);
  if (!url) throw new Error("Missing SUPABASE_URL / VITE_SUPABASE_URL");

  const serviceKey = getServiceKey(env);
  if (!serviceKey) {
    throw new Error("Need SUPABASE_SERVICE_ROLE_KEY in .env");
  }

  if (isProdSupabaseUrl(url) && process.env.STAYSEE_ALLOW_PROD_TESTS !== "1") {
    throw new Error(
      "Prod smoke tests are disabled unless STAYSEE_ALLOW_PROD_TESTS=1 is set in the environment"
    );
  }

  const testUserId =
    process.env.STAYSEE_TEST_USER_ID ?? env.STAYSEE_TEST_USER_ID ?? "";
  if (!testUserId) {
    throw new Error(
      "STAYSEE_TEST_USER_ID is required for prod smoke/audit scripts. " +
        "Create a dedicated technical test user and set it in .env — never use a real user profile."
    );
  }

  return { url, serviceKey, testUserId };
}

export function buildTestConversationTitle(suffix) {
  const title = `${TEST_TITLE_PREFIX} ${suffix}`.trim();
  if (!title.startsWith(TEST_TITLE_PREFIX)) {
    throw new Error("Prod test conversation title must start with __TEST__");
  }
  return title;
}

export function assertTestConversationTitle(title) {
  if (!title.startsWith(TEST_TITLE_PREFIX)) {
    throw new Error(`Prod test conversation title must start with ${TEST_TITLE_PREFIX}`);
  }
}

export function makeServiceHeaders(serviceKey) {
  return {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    "Content-Type": "application/json",
  };
}

export async function restJson(baseUrl, headers, path, opts = {}) {
  const res = await fetch(`${baseUrl}/rest/v1/${path}`, {
    headers: { ...headers, ...(opts.prefer ? { Prefer: opts.prefer } : {}) },
    ...opts,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Delete test conversation and related rows (service role).
 */
export async function deleteTestConversation(baseUrl, headers, conversationId) {
  const msgRows = await restJson(
    baseUrl,
    headers,
    `messages?conversation_id=eq.${conversationId}&select=id`
  );
  const messageIds = (msgRows ?? []).map((r) => r.id).filter(Boolean);

  if (messageIds.length > 0) {
    const inList = messageIds.map((id) => `"${id}"`).join(",");
    await restJson(
      baseUrl,
      headers,
      `message_embeddings?message_id=in.(${inList})`,
      { method: "DELETE", prefer: "return=minimal" }
    );
  }

  await restJson(baseUrl, headers, `message_embeddings?conversation_id=eq.${conversationId}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
  await restJson(baseUrl, headers, `messages?conversation_id=eq.${conversationId}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
  await restJson(baseUrl, headers, `progress_entries?conversation_id=eq.${conversationId}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
  await restJson(baseUrl, headers, `conversations?id=eq.${conversationId}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
}

export async function createTestConversation(baseUrl, headers, testUserId, titleSuffix) {
  const title = buildTestConversationTitle(titleSuffix);
  const rows = await restJson(baseUrl, headers, "conversations", {
    method: "POST",
    prefer: "return=representation",
    body: JSON.stringify({ user_id: testUserId, title }),
  });
  const conversationId = rows?.[0]?.id;
  if (!conversationId) throw new Error("conversation create failed");
  return { conversationId, title };
}

export async function seedMessage(baseUrl, headers, conversationId, testUserId, role, content) {
  await restJson(baseUrl, headers, "messages", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify({
      conversation_id: conversationId,
      user_id: testUserId,
      sender: role === "user" ? "user" : "ai",
      role,
      content,
    }),
  });
}

/**
 * Run prod test with guaranteed cleanup in finally.
 */
export async function withTestConversation(
  { url, serviceKey, testUserId },
  titleSuffix,
  fn
) {
  const headers = makeServiceHeaders(serviceKey);
  let conversationId = null;
  try {
    const created = await createTestConversation(url, headers, testUserId, titleSuffix);
    conversationId = created.conversationId;
    return await fn({ conversationId, title: created.title, headers, testUserId });
  } finally {
    if (conversationId) {
      try {
        await deleteTestConversation(url, headers, conversationId);
        console.log(`\n[cleanup] deleted test conversation ${conversationId}`);
      } catch (e) {
        console.error(`[cleanup] FAILED for ${conversationId}:`, e.message);
      }
    }
  }
}
