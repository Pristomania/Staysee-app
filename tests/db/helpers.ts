import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Database integration tests run against a real local Supabase (Postgres +
// PostgREST + auth), started with `supabase start`. They prove what the
// offline suite cannot: how real Postgres and PostgREST behave. See
// scripts/run-db-tests.mjs for how the connection settings are provided.

export function adminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const sha256hex = (text: string): string => createHash("sha256").update(text).digest("hex");

// Message ids are ordered by construction: the same prefix with a larger n
// is always a larger uuid, so a test knows the exact (created_at, id) order.
export const messageId = (prefix: string, n: number): string =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export async function must<T>(
  query: PromiseLike<{ data: T; error: { message: string } | null }>,
  label: string,
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

export async function createUser(client: SupabaseClient, label: string): Promise<string> {
  const email = `db-test-${label}-${sha256hex(`${label}-${Date.now()}-${Math.random()}`).slice(0, 12)}@example.invalid`;
  const { data, error } = await client.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message ?? "no user"}`);
  return data.user.id;
}

// Deleting the user cascades to its conversations, messages and memory rows.
export async function deleteUser(client: SupabaseClient, userId: string): Promise<void> {
  const { error } = await client.auth.admin.deleteUser(userId);
  if (error) throw new Error(`deleteUser: ${error.message}`);
}

export async function createConversation(client: SupabaseClient, userId: string): Promise<string> {
  const rows = await must(
    client.from("conversations").insert({ user_id: userId }).select("id"),
    "create conversation",
  ) as Array<{ id: string }>;
  return rows[0].id;
}

export async function addMessages(
  client: SupabaseClient,
  conversationId: string,
  rows: Array<{ id: string; at: string; sender?: "user" | "ai" }>,
): Promise<void> {
  await must(
    client.from("messages").insert(rows.map((row) => ({
      id: row.id,
      conversation_id: conversationId,
      sender: row.sender ?? "user",
      content: "x",
      created_at: row.at,
    }))),
    "add messages",
  );
}
