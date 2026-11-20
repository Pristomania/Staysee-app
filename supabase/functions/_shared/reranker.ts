/**
 * The reranker that sorts the lines found by the search by meaning.
 *
 * The vectors answer "is this line about the same thing"; the reranker reads the pair (question, line) and answers "does this
 * line answer the question". Measured on a made-up conversation of nine months (21.11.2026): with it the wrong lines per question fell
 * from 2.7 to about 1 and the right line stood first much more often; without it no single threshold separated the right from
 * the merely similar. Cloud.ru, model BAAI/bge-reranker-v2-m3, about 0.2 s a call and a hundredth of a kopeck.
 *
 * A failure of any kind returns null: the caller then falls back to the threshold on the vectors.
 */

export const RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
export const RERANK_URL = "https://foundation-models.api.cloud.ru/rerank";
/** The score (0..1) above which a line counts as an answer. Measured: 0.05 finds most, 0.1 is stricter; STAYSEE_RERANK_THRESHOLD changes it. */
export const DEFAULT_RERANK_THRESHOLD = 0.05;
const RERANK_CHUNK = 20;
const RERANK_TIMEOUT_MS = 3000;
const MAX_DOCUMENT_CHARS = 1200;

export function resolveRerankThreshold(raw: string | undefined | null): number {
  const value = Number(raw);
  if (raw && Number.isFinite(value) && value > 0 && value < 1) return value;
  return DEFAULT_RERANK_THRESHOLD;
}

export interface RerankUsage {
  totalTokens: number;
}

export interface RerankConfig {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  url?: string;
  /** Called once per call to the provider (the money is spent either way): the chat writes it into the cost log. */
  onUsage?: (usage: RerankUsage) => void | Promise<void>;
  /** Called when the provider refuses the key (401, 403) or has no money (402): the chat raises the alert. */
  onRefusal?: (status: 401 | 402 | 403) => void | Promise<void>;
}

/** One score per document, in the order of the documents; null when the answer is not what is expected. */
export function readRerankScores(data: unknown, count: number): number[] | null {
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return null;
  const scores: Array<number | null> = new Array(count).fill(null);
  for (const row of results as Array<{ index?: unknown; relevance_score?: unknown }>) {
    if (Number.isInteger(row.index) && typeof row.relevance_score === "number" && (row.index as number) >= 0 && (row.index as number) < count) {
      scores[row.index as number] = row.relevance_score;
    }
  }
  return scores.every((s) => s !== null) ? (scores as number[]) : null;
}

export async function rerankLines(
  query: string,
  documents: string[],
  config: RerankConfig
): Promise<number[] | null> {
  if (!documents.length) return [];
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = config.url ?? RERANK_URL;
  const clipped = documents.map((d) => d.replace(/\s+/g, " ").trim().slice(0, MAX_DOCUMENT_CHARS) || " ");

  const chunks: string[][] = [];
  for (let i = 0; i < clipped.length; i += RERANK_CHUNK) chunks.push(clipped.slice(i, i + RERANK_CHUNK));

  try {
    const parts = await Promise.all(
      chunks.map(async (chunk) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? RERANK_TIMEOUT_MS);
        try {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: RERANK_MODEL, query, documents: chunk }),
            signal: controller.signal,
          });
          if (!response.ok) {
            console.warn(`[reranker] HTTP ${response.status}`);
            if (config.onRefusal && (response.status === 401 || response.status === 402 || response.status === 403)) {
              try {
                await config.onRefusal(response.status);
              } catch (e) {
                console.warn("[reranker] refusal handler failed:", e);
              }
            }
            return null;
          }
          const data = await response.json();
          const total = data?.usage?.total_tokens ?? data?.usage?.prompt_tokens;
          if (config.onUsage && typeof total === "number" && total > 0) {
            try {
              await config.onUsage({ totalTokens: Math.round(total) });
            } catch (e) {
              console.warn("[reranker] usage logger failed:", e);
            }
          }
          return readRerankScores(data, chunk.length);
        } finally {
          clearTimeout(timer);
        }
      })
    );
    if (parts.some((p) => p === null)) return null;
    return (parts as number[][]).flat();
  } catch (e) {
    console.warn("[reranker] failed:", e instanceof Error ? e.message : "unknown");
    return null;
  }
}
