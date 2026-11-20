/**
 * OpenRouter embeddings (server-side only).
 */

import { OPENROUTER_PRIVATE_ROUTE } from "./openRouterPrivateRoute.ts";
import { readEmbeddingUsage, type EmbeddingUsage } from "./embeddingUsage.ts";

/**
 * The model that makes the vectors for the search by meaning. An open-weights model on purpose: it can be moved to another
 * host (Cloud.ru, a machine of our own) and make the SAME vectors there, so nothing has to be recomputed when the host changes.
 * Every vector is stored with the name of the model that made it, and only vectors of the current model are ever compared.
 */
export const DEFAULT_EMBEDDING_MODEL = "baai/bge-m3";

function readEmbeddingModelFromEnv(): string | undefined {
  // The tests run in Node, where there is no Deno: the default is used there.
  if (typeof Deno === "undefined") return undefined;
  return Deno.env.get("STAYSEE_EMBEDDING_MODEL")?.trim() || undefined;
}

export const EMBEDDING_MODEL = readEmbeddingModelFromEnv() ?? DEFAULT_EMBEDDING_MODEL;

/** The length of one vector of the model above (bge-m3: 1024). A vector of any other length is refused, never stored. */
export const EMBEDDING_DIMENSIONS = 1024;

const MAX_EMBED_CHARS = 6_000;

export interface EmbeddingApiConfig {
  apiKey: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  /**
   * Called once with what the call cost, right after the provider answered (before the vectors are checked: the call was paid either
   * way). The chat passes a function that writes the cost into ai_usage_logs. A failure in it never fails the embeddings.
   */
  onUsage?: (usage: EmbeddingUsage) => void | Promise<void>;
}

function normalizeInput(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return " ";
  return t.slice(0, MAX_EMBED_CHARS);
}

/** Create embeddings for one or more texts via OpenRouter. */
export async function createEmbeddings(
  texts: string[],
  config: EmbeddingApiConfig
): Promise<number[][]> {
  if (!texts.length) return [];

  const baseUrl = config.baseUrl ?? "https://openrouter.ai/api/v1";
  const inputs = texts.map(normalizeInput);
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...(config.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
      ...(baseUrl.includes("openrouter.ai") ? { provider: OPENROUTER_PRIVATE_ROUTE } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn("[embeddings] API failed:", res.status, errText.slice(0, 200));
    throw new Error(`embeddings_http_${res.status}`);
  }

  const data = await res.json();

  // The provider has answered, so the call is paid whatever happens to the vectors below: write the cost first.
  if (config.onUsage) {
    try {
      await config.onUsage(readEmbeddingUsage(data, EMBEDDING_MODEL, inputs));
    } catch (e) {
      console.warn("[embeddings] usage logger failed:", e);
    }
  }

  const rows = data.data as Array<{ embedding: number[]; index: number }>;
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("embeddings_empty_response");
  }

  const sorted = [...rows].sort((a, b) => a.index - b.index);
  return sorted.map((r) => {
    const emb = r.embedding;
    if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`embedding_bad_dim:${emb?.length ?? 0}`);
    }
    return emb;
  });
}

export async function createQueryEmbedding(
  query: string,
  config: EmbeddingApiConfig
): Promise<number[]> {
  const [vec] = await createEmbeddings([query], config);
  return vec;
}
