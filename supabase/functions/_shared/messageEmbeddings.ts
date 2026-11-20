/**
 * Store and search message embeddings — scoped to one conversation_id only.
 *
 * A vector is stored together with the name of the model that made it (embedding_model), and a search reads only the
 * vectors of the current model: vectors of two models never meet. The search covers the WHOLE conversation: the database
 * does the comparing (migration 107), nothing is cut to "the first 400 messages".
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  createEmbeddings,
  createQueryEmbedding,
  EMBEDDING_MODEL,
  type EmbeddingApiConfig,
} from "./embeddings.ts";
import type { ArchiveExcerpt } from "./conversationRetrieval.ts";
import {
  isAssistantMessage,
  isUserMessage,
  toDbSender,
  type MessageRoleFields,
} from "./messageRole.ts";

const ENSURE_BATCH = 20;
const MAX_ENSURE_PER_REQUEST = 40;
const MAX_ENSURE_HARD = 80;
export const SEMANTIC_MATCH_COUNT = 12;
/**
 * A line of the person shorter than this is never a hit of the search by meaning (a length, not a word). Measured on a made-up
 * conversation of nine months (21.11.2026): fillers like «наверное», «ну да», «устала» are close in meaning to many questions and
 * crowd out the right line, but a cut at 20 characters also lost every short fact («Мне 31 год.», «Живу в Туле.», «Я левша.»:
 * 0 of 5 found). At 10 the short facts are found (4 of 5) and the right line is found in 24 of 28 questions instead of 20.
 */
export const SEMANTIC_MIN_LINE_CHARS = 10;

/**
 * How close in meaning a past message must be to count as a hit. Measured on bge-m3 (20.11.2026, made-up Russian phrases):
 * the same meaning in other words 0.64–0.80, an unrelated phrase 0.44–0.52, so 0.58 sits between them. It is a starting
 * value, to be tuned on a copy of a long real conversation; STAYSEE_SEMANTIC_THRESHOLD changes it without a deploy of code.
 */
export const DEFAULT_SEMANTIC_THRESHOLD = 0.58;

export function resolveSemanticThreshold(raw: string | undefined | null): number {
  const value = Number(raw);
  if (raw && Number.isFinite(value) && value >= 0.3 && value <= 0.95) return value;
  return DEFAULT_SEMANTIC_THRESHOLD;
}

function semanticThreshold(): number {
  if (typeof Deno === "undefined") return DEFAULT_SEMANTIC_THRESHOLD;
  return resolveSemanticThreshold(Deno.env.get("STAYSEE_SEMANTIC_THRESHOLD"));
}

interface MissingMessageRow extends MessageRoleFields {
  id: string;
  content: string;
  created_at: string;
}

function embedTextForMessage(row: MessageRoleFields, content: string): string {
  const label = isUserMessage(row) ? "Пользователь" : "StaySee";
  return `${label}: ${content.replace(/\s+/g, " ").trim()}`;
}

/**
 * Embed the newest messages of this conversation that have no vector of the current model yet (service role).
 * Called after every reply (a few messages) and, when someone asks to remember, with a larger number — a long conversation
 * is caught up in a few turns, newest first.
 */
export async function ensureConversationEmbeddings(
  supabaseSvc: SupabaseClient,
  params: {
    conversationId: string;
    userId: string;
    embedConfig: EmbeddingApiConfig;
    maxMessages?: number;
  }
): Promise<number> {
  const limit = Math.max(1, Math.min(params.maxMessages ?? MAX_ENSURE_PER_REQUEST, MAX_ENSURE_HARD));

  const { data, error } = await supabaseSvc.rpc("messages_missing_embeddings", {
    p_conversation_id: params.conversationId,
    p_model: EMBEDDING_MODEL,
    p_limit: limit,
  });

  if (error) {
    console.warn("[messageEmbeddings] missing lookup:", error.message);
    return 0;
  }

  const missing = (Array.isArray(data) ? data : []) as MissingMessageRow[];
  if (!missing.length) return 0;

  let embedded = 0;

  for (let i = 0; i < missing.length; i += ENSURE_BATCH) {
    const batch = missing.slice(i, i + ENSURE_BATCH);
    const texts = batch.map((m) => embedTextForMessage(m, m.content));

    try {
      const vectors = await createEmbeddings(texts, params.embedConfig);
      const rows = batch.map((m, idx) => ({
        message_id: m.id,
        conversation_id: params.conversationId,
        user_id: params.userId,
        sender: toDbSender(m),
        embedding_model: EMBEDDING_MODEL,
        embedding_1024: vectors[idx],
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
      `[messageEmbeddings] embedded=${embedded} model=${EMBEDDING_MODEL} conversation=${params.conversationId}`
    );
  }

  return embedded;
}

interface SemanticHitRow extends MessageRoleFields {
  message_id: string;
  content: string;
  created_at: string;
  similarity: number;
  reply_sender?: string | null;
  reply_role?: string | null;
  reply_content?: string | null;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

export function semanticRowsToExcerpts(hits: SemanticHitRow[], maxChars: number): ArchiveExcerpt[] {
  const excerpts: ArchiveExcerpt[] = [];
  const seen = new Set<string>();

  for (const hit of hits) {
    if (!isUserMessage(hit)) continue;
    if (seen.has(hit.message_id)) continue;
    seen.add(hit.message_id);

    const replyText = hit.reply_content?.trim() ?? "";
    const replyIsAssistant =
      replyText.length > 0 &&
      isAssistantMessage({ sender: hit.reply_sender, role: hit.reply_role });

    excerpts.push({
      userText: clip(hit.content, maxChars),
      assistantText: replyIsAssistant ? clip(replyText, maxChars) : null,
      createdAt: hit.created_at,
      score: hit.similarity + 10,
    });
  }

  return excerpts;
}

/** Semantic similarity search — current conversation only, whole history, current model only. */
export async function searchSemanticConversationArchive(
  supabaseUser: SupabaseClient,
  params: {
    conversationId: string;
    query: string;
    /** Only messages older than this are searched (the latest ones are already in the prompt). */
    beforeCreatedAt: string | null;
    embedConfig: EmbeddingApiConfig;
    maxExcerptChars: number;
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

  const { data, error } = await supabaseUser.rpc("match_conversation_embeddings_by_model", {
    p_conversation_id: params.conversationId,
    p_model: EMBEDDING_MODEL,
    query_embedding: queryVector,
    match_count: SEMANTIC_MATCH_COUNT,
    match_threshold: semanticThreshold(),
    p_before_created_at: params.beforeCreatedAt,
    p_min_chars: SEMANTIC_MIN_LINE_CHARS,
  });

  if (error) {
    if (error.message.includes("match_conversation") || error.message.includes("message_embeddings")) {
      console.warn("[messageEmbeddings] RPC unavailable (migration?):", error.message);
    } else {
      console.warn("[messageEmbeddings] search:", error.message);
    }
    return [];
  }

  const excerpts = semanticRowsToExcerpts(
    (Array.isArray(data) ? data : []) as SemanticHitRow[],
    params.maxExcerptChars
  );
  if (excerpts.length) {
    console.log(
      `[messageEmbeddings] semantic hits=${excerpts.length} model=${EMBEDDING_MODEL} conversation=${params.conversationId}`
    );
  }
  return excerpts;
}
