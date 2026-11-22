/**
 * The reranker that sorts the lines found by the search by meaning.
 *
 * The vectors answer "is this line about the same thing"; the reranker reads the pair (question, line) and answers "does this
 * line answer the question". Measured on a made-up conversation of nine months (21.11.2026): with it the wrong lines per question fell
 * from 2.7 to about 1 and the right line stood first much more often; without it no single threshold separated the right from
 * the merely similar. Cloud.ru, model BAAI/bge-reranker-v2-m3, about 0.2 s a call and a hundredth of a kopeck.
 *
 * A failure of any kind returns null: the caller then falls back to the threshold on the vectors.
 *
 * Cloud.ru is the main host. When it refuses (the key, or the balance: an empty balance answers 403) the reserve on OpenRouter is asked
 * (an open model, through the private route) and Cloud.ru is left alone for a few minutes: see searchProviders.ts.
 */

import { OPENROUTER_PRIVATE_ROUTE } from "./openRouterPrivateRoute.ts";
import {
  FALLBACK_RERANK_MODEL,
  OPENROUTER_RERANK_URL,
  type OpenRouterAccess,
  type SwitchReason,
  cloudruIsPaused,
  cloudruLastRefusalStatus,
  pauseCloudru,
  resumeCloudru,
} from "./searchProviders.ts";

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
  /** What the host charged, when it says so (OpenRouter does): the cost log takes it as it is. */
  costUsd?: number;
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


/** The reserve on OpenRouter: the same chunks and the same shape of the answer, through the private route. */
export interface OpenRouterRerankConfig extends OpenRouterAccess {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onUsage?: (usage: RerankUsage) => void | Promise<void>;
}

const OPENROUTER_RERANK_TIMEOUT_MS = 5000;

export async function rerankViaOpenRouter(
  query: string,
  documents: string[],
  config: OpenRouterRerankConfig
): Promise<number[] | null> {
  if (!documents.length) return [];
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const clipped = documents.map((d) => d.replace(/\s+/g, " ").trim().slice(0, MAX_DOCUMENT_CHARS) || " ");
  const chunks: string[][] = [];
  for (let i = 0; i < clipped.length; i += RERANK_CHUNK) chunks.push(clipped.slice(i, i + RERANK_CHUNK));

  try {
    const parts = await Promise.all(
      chunks.map(async (chunk) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? OPENROUTER_RERANK_TIMEOUT_MS);
        try {
          const response = await fetchImpl(OPENROUTER_RERANK_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", ...(config.extraHeaders ?? {}) },
            body: JSON.stringify({ model: FALLBACK_RERANK_MODEL, query, documents: chunk, provider: OPENROUTER_PRIVATE_ROUTE }),
            signal: controller.signal,
          });
          if (!response.ok) {
            console.warn(`[reranker] OpenRouter HTTP ${response.status}`);
            return null;
          }
          const data = await response.json();
          const total = data?.usage?.total_tokens ?? data?.usage?.prompt_tokens;
          const cost = data?.usage?.cost;
          if (config.onUsage && ((typeof total === "number" && total > 0) || typeof cost === "number")) {
            try {
              await config.onUsage({
                totalTokens: typeof total === "number" && total > 0 ? Math.round(total) : 0,
                ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
              });
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
    console.warn("[reranker] OpenRouter failed:", e instanceof Error ? e.message : "unknown");
    return null;
  }
}

export interface RankedLines {
  /** One score per line, or null when no host could score them (the caller falls back to the threshold on the vectors). */
  scores: number[] | null;
  /** Who scored them. The scores of the two hosts are on different scales: the caller picks the threshold by this. */
  provider: "cloudru" | "openrouter" | null;
  /** Cloud.ru refused the key or has no money (401, 402, 403). */
  refusedStatus?: 401 | 402 | 403;
  /** Set when the reserve scored the lines instead of Cloud.ru, and why. */
  switchedBecause?: SwitchReason;
}

/**
 * Cloud.ru first; when it refuses or does not answer, the reserve on OpenRouter. After a refusal Cloud.ru is left alone for a few minutes,
 * then asked again; a good answer from it ends the pause.
 */
export async function rerankWithFallback(
  query: string,
  documents: string[],
  config: { cloudru?: RerankConfig; openrouter?: OpenRouterRerankConfig; now?: number }
): Promise<RankedLines> {
  const now = config.now ?? Date.now();
  let refusedStatus: 401 | 402 | 403 | undefined;
  let switchedBecause: SwitchReason | undefined;

  if (config.cloudru && !cloudruIsPaused(now)) {
    const scores = await rerankLines(query, documents, {
      ...config.cloudru,
      onRefusal: async (status) => {
        refusedStatus = status;
        await config.cloudru?.onRefusal?.(status);
      },
    });
    if (scores) {
      resumeCloudru();
      return { scores, provider: "cloudru" };
    }
    if (refusedStatus) pauseCloudru(now, refusedStatus);
    switchedBecause = refusedStatus ? "refused" : "unavailable";
  } else if (config.cloudru) {
    switchedBecause = "paused";
    refusedStatus = cloudruLastRefusalStatus();
  }

  if (config.openrouter) {
    const scores = await rerankViaOpenRouter(query, documents, config.openrouter);
    if (scores) {
      return { scores, provider: "openrouter", ...(refusedStatus ? { refusedStatus } : {}), ...(switchedBecause ? { switchedBecause } : {}) };
    }
  }
  return { scores: null, provider: null, ...(refusedStatus ? { refusedStatus } : {}) };
}
