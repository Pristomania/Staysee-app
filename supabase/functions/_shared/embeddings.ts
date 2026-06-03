/**
 * OpenRouter embeddings (server-side only).
 */

export const EMBEDDING_MODEL =
  Deno.env.get("STAYSEE_EMBEDDING_MODEL")?.trim() ||
  "openai/text-embedding-3-small";

export const EMBEDDING_DIMENSIONS = 1536;

const MAX_EMBED_CHARS = 6_000;

export interface EmbeddingApiConfig {
  apiKey: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
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
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...(config.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts.map(normalizeInput),
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn("[embeddings] API failed:", res.status, errText.slice(0, 200));
    throw new Error(`embeddings_http_${res.status}`);
  }

  const data = await res.json();
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
