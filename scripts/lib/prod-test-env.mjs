/**
 * Shared guard + helpers for prod smoke / audit scripts.
 * Never create conversations on real user profiles without STAYSEE_TEST_USER_ID.
 * Never use profiles?limit=1 (or similar) as implicit user source on production.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TEST_CONVERSATION_TITLE_RE,
  isTestConversationTitle,
} from "./test-conversation-title.mjs";

export { TEST_CONVERSATION_TITLE_RE, isTestConversationTitle };

export const TEST_TITLE_PREFIX = "__TEST__";

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

const PRODUCTION_PROJECT_HOST = "jnxrildlwvtxhtiwucbt.supabase.co";

export function isProdSupabaseUrl(url) {
  return /supabase\.co/i.test(url) && !/localhost|127\.0\.0\.1/i.test(url);
}

/** Production project only — not staging. */
export function isProductionProjectUrl(url) {
  return (url ?? "").replace(/\/$/, "").includes(PRODUCTION_PROJECT_HOST);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Prod writes must target an explicit dedicated test user — never a profile picked from limit=1.
 */
export function assertExplicitTestUserId(testUserId) {
  const id = (testUserId ?? "").trim();
  if (!id) {
    throw new Error(
      "STAYSEE_TEST_USER_ID is required for prod smoke/audit scripts. " +
        "Create a dedicated technical test user — never use a real user profile."
    );
  }
  if (!UUID_RE.test(id)) {
    throw new Error(`STAYSEE_TEST_USER_ID must be a UUID, got: ${id}`);
  }
  return id;
}

/**
 * Blocks the ad-hoc anti-pattern: profiles?select=id&limit=1 → first real user.
 */
export function guardProdRestPath(baseUrl, path) {
  if (!isProductionProjectUrl(baseUrl)) return;
  const isProfileList =
    /^profiles\?/i.test(path) &&
    /(?:^|[&?])limit=1(?:&|$)/i.test(path) &&
    !/(?:^|[&?])id=eq\./i.test(path);
  if (isProfileList) {
    throw new Error(
      "Prod guard: never use profiles?limit=1 as implicit user source. " +
        "Set STAYSEE_TEST_USER_ID explicitly for test/audit writes."
    );
  }
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

  const testUserId = assertExplicitTestUserId(
    process.env.STAYSEE_TEST_USER_ID ?? env.STAYSEE_TEST_USER_ID ?? ""
  );

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
  guardProdRestPath(baseUrl, path);
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
  assertExplicitTestUserId(testUserId);
  if (isProdSupabaseUrl(baseUrl) && process.env.STAYSEE_ALLOW_PROD_TESTS !== "1") {
    throw new Error(
      "Prod conversation create blocked unless STAYSEE_ALLOW_PROD_TESTS=1 is set"
    );
  }
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
  assertExplicitTestUserId(testUserId);
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
