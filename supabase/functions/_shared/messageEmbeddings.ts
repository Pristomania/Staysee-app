/**
 * Store and search message embeddings — scoped to one conversation_id only.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  createEmbeddings,
  createQueryEmbedding,
  type EmbeddingApiConfig,
} from "./embeddings.ts";
import type { ArchiveExcerpt } from "./conversationRetrieval.ts";

const ENSURE_BATCH = 20;
const MAX_ENSURE_PER_REQUEST = 40;
const SEMANTIC_MATCH_COUNT = 12;
const SEMANTIC_THRESHOLD = 0.24;

interface MessageRow {
  id: string;
  conversation_id: string;
  sender: string;
  content: string;
  created_at: string;
}

function embedTextForMessage(sender: string, content: string): string {
  const role = sender === "user" ? "Пользователь" : "StaySee";
  return `${role}: ${content.replace(/\s+/g, " ").trim()}`;
}

/** Embed messages in this conversation that lack vectors (service role). */
export async function ensureConversationEmbeddings(
  supabaseSvc: SupabaseClient,
  params: {
    conversationId: string;
    userId: string;
    embedConfig: EmbeddingApiConfig;
    maxMessages?: number;
  }
): Promise<number> {
  const limit = Math.min(params.maxMessages ?? MAX_ENSURE_PER_REQUEST, 80);

  const { data: messages, error } = await supabaseSvc
    .from("messages")
    .select("id, conversation_id, sender, content, created_at")
    .eq("conversation_id", params.conversationId)
    .order("created_at", { ascending: true })
    .limit(400);

  if (error || !messages?.length) {
    if (error) console.warn("[messageEmbeddings] fetch:", error.message);
    return 0;
  }

  const { data: existing } = await supabaseSvc
    .from("message_embeddings")
    .select("message_id")
    .eq("conversation_id", params.conversationId);

  const have = new Set((existing ?? []).map((r) => r.message_id as string));

  const missing = (messages as MessageRow[])
    .filter((m) => m.content?.trim() && !have.has(m.id))
    .slice(-limit);

  if (!missing.length) return 0;

  let embedded = 0;

  for (let i = 0; i < missing.length; i += ENSURE_BATCH) {
    const batch = missing.slice(i, i + ENSURE_BATCH);
    const texts = batch.map((m) => embedTextForMessage(m.sender, m.content));

    try {
      const vectors = await createEmbeddings(texts, params.embedConfig);
      const rows = batch.map((m, idx) => ({
        message_id: m.id,
        conversation_id: params.conversationId,
        user_id: params.userId,
        sender: m.sender,
        embedding: vectors[idx],
      }));

      const { error: insErr } = await supabaseSvc
        .from("message_embeddings")
        .upsert(rows, { onConflict: "message_id" });

      if (insErr) {
        console.warn("[messageEmbeddings] upsert:", insErr.message);
        break;
      }
      embedded += batch.length;
    } catch (e) {
      console.warn("[messageEmbeddings] batch failed:", e);
      break;
    }
  }

  if (embedded > 0) {
    console.log(
      `[messageEmbeddings] embedded=${embedded} conversation=${params.conversationId}`
    );
  }

  return embedded;
}

function rowsToExcerpts(
  hits: Array<{
    message_id: string;
    sender: string;
    content: string;
    created_at: string;
    similarity: number;
  }>,
  allMessages: MessageRow[]
): ArchiveExcerpt[] {
  const byTime = [...allMessages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  const excerpts: ArchiveExcerpt[] = [];
  const seen = new Set<string>();

  for (const hit of hits) {
    if (hit.sender !== "user") continue;
    const key = hit.message_id;
    if (seen.has(key)) continue;
    seen.add(key);

    let assistantText: string | null = null;
    const idx = byTime.findIndex((m) => m.id === hit.message_id);
    if (idx >= 0) {
      const next = byTime[idx + 1];
      if (next?.sender === "ai") {
        assistantText = next.content?.trim() ?? null;
      }
    }

    excerpts.push({
      userText: hit.content.trim(),
      assistantText,
      createdAt: hit.created_at,
      score: hit.similarity + 10,
    });
  }

  return excerpts;
}

/** Semantic similarity search — current conversation only. */
export async function searchSemanticConversationArchive(
  supabaseUser: SupabaseClient,
  params: {
    conversationId: string;
    query: string;
    excludeTailCount: number;
    embedConfig: EmbeddingApiConfig;
    allMessages: MessageRow[];
  }
): Promise<ArchiveExcerpt[]> {
  const query = params.query.trim();
  if (query.length < 3) return [];

  let queryVector: number[];
  try {
    queryVector = await createQueryEmbedding(query, params.embedConfig);
  } catch (e) {
    console.warn("[messageEmbeddings] query embed failed:", e);
    return [];
  }

  const sorted = [...params.allMessages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const tail = Math.max(0, params.excludeTailCount);
  const cutoff =
    tail > 0 && sorted.length > tail
      ? sorted[sorted.length - tail].created_at
      : null;

  const { data, error } = await supabaseUser.rpc(
    "match_conversation_message_embeddings",
    {
      p_conversation_id: params.conversationId,
      query_embedding: queryVector,
      match_count: SEMANTIC_MATCH_COUNT,
      match_threshold: SEMANTIC_THRESHOLD,
      p_before_created_at: cutoff,
    }
  );

  if (error) {
    if (
      error.message.includes("message_embeddings") ||
      error.message.includes("match_conversation")
    ) {
      console.warn("[messageEmbeddings] RPC unavailable (migration?):", error.message);
    } else {
      console.warn("[messageEmbeddings] search:", error.message);
    }
    return [];
  }

  const hits = (data ?? []) as Array<{
    message_id: string;
    sender: string;
    content: string;
    created_at: string;
    similarity: number;
  }>;

  const excerpts = rowsToExcerpts(hits, params.allMessages);
  if (excerpts.length) {
    console.log(
      `[messageEmbeddings] semantic hits=${excerpts.length} conversation=${params.conversationId}`
    );
  }
  return excerpts;
}
