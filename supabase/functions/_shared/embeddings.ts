/**
 * The vectors for the search by meaning (server-side only).
 *
 * Cloud.ru (Russia) is asked first; OpenRouter is the reserve. When Cloud.ru refuses (the key or the balance) it is left alone
 * for a few minutes, as for the rest of the search (searchProviders.ts). Both hosts run the same open model and make the same
 * vectors (measured on 28.11.2026: closeness 1.00000 on 23 made-up messages), so the stored vectors keep one label.
 */

import { CLOUDRU_BASE_URL } from "./modelHost.ts";
import { OPENROUTER_PRIVATE_ROUTE } from "./openRouterPrivateRoute.ts";
import { readEmbeddingUsage, type EmbeddingUsage } from "./embeddingUsage.ts";
import {
  type SwitchReason,
  cloudruIsPaused,
  cloudruLastRefusalStatus,
  pauseCloudru,
  resumeCloudru,
} from "./searchProviders.ts";

/**
 * The model that makes the vectors for the search by meaning. An open-weights model on purpose: it can be moved to another
 * host (Cloud.ru, a machine of our own) and make the SAME vectors there, so nothing has to be recomputed when the host changes.
 * Every vector is stored with the name of the model that made it, and only vectors of the current model are ever compared.
 */
export const DEFAULT_EMBEDDING_MODEL = "baai/bge-m3";
/** The name of the same model on Cloud.ru. The stored vectors keep DEFAULT_EMBEDDING_MODEL; this name goes only into the request and the cost log. */
export const CLOUDRU_EMBEDDING_MODEL = "BAAI/bge-m3";

function readEmbeddingModelFromEnv(): string | undefined {
  // The tests run in Node, where there is no Deno: the default is used there.
  if (typeof Deno === "undefined") return undefined;
  return Deno.env.get("STAYSEE_EMBEDDING_MODEL")?.trim() || undefined;
}

export const EMBEDDING_MODEL = readEmbeddingModelFromEnv() ?? DEFAULT_EMBEDDING_MODEL;

/** The length of one vector of the model above (bge-m3: 1024). A vector of any other length is refused, never stored. */
export const EMBEDDING_DIMENSIONS = 1024;

const MAX_EMBED_CHARS = 6_000;
/** A usual call takes well under a second; after this long the reserve is asked. */
const CLOUDRU_EMBED_TIMEOUT_MS = 8_000;

/** What happened when Cloud.ru was one of the hosts: the same shape as for the reranker, for the same alerts. */
export interface EmbeddingHostOutcome {
  /** The vectors were made (by either host). */
  served: boolean;
  /** Cloud.ru refused the key or has no money. */
  refusedStatus?: 401 | 402 | 403;
  /** Set when Cloud.ru did not make them, and why. */
  switchedBecause?: SwitchReason;
}

export interface EmbeddingApiConfig {
  /** The OpenRouter key: the only host when Cloud.ru is not given, the reserve otherwise. */
  apiKey?: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  /** Cloud.ru, asked first when given. */
  cloudru?: { apiKey: string; timeoutMs?: number };
  fetchImpl?: typeof fetch;
  /**
   * Called once per paid call with what it cost, right after the provider answered (before the vectors are checked: the call was paid
   * either way). The chat passes a function that writes the cost into ai_usage_logs. A failure in it never fails the embeddings.
   */
  onUsage?: (usage: EmbeddingUsage) => void | Promise<void>;
  /** Called once per request when Cloud.ru is one of the hosts: the chat raises the alert from it. A failure in it changes nothing. */
  onHostOutcome?: (outcome: EmbeddingHostOutcome) => void | Promise<void>;
}

/** The hosts a server has, from the keys it has; undefined when it has none (then there is no search by meaning). */
export function embeddingAccess(keys: {
  cloudruKey: string | undefined;
  openrouterKey: string | undefined;
  openrouterHeaders?: Record<string, string>;
}): Pick<EmbeddingApiConfig, "apiKey" | "extraHeaders" | "cloudru"> | undefined {
  if (!keys.cloudruKey && !keys.openrouterKey) return undefined;
  return {
    ...(keys.openrouterKey ? { apiKey: keys.openrouterKey, extraHeaders: keys.openrouterHeaders } : {}),
    ...(keys.cloudruKey ? { cloudru: { apiKey: keys.cloudruKey } } : {}),
  };
}

function normalizeInput(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return " ";
  return t.slice(0, MAX_EMBED_CHARS);
}

class EmbeddingHttpError extends Error {
  constructor(readonly status: number) {
    super(`embeddings_http_${status}`);
  }
}

interface HostRequest {
  baseUrl: string;
  apiKey: string;
  /** The name this host knows the model by. */
  model: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** One request to one host: the vectors in the order of the inputs, or a thrown error. */
async function requestVectors(inputs: string[], host: HostRequest, config: EmbeddingApiConfig): Promise<number[][]> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseUrl = host.baseUrl;
  const controller = host.timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), host.timeoutMs) : undefined;
  try {
    const res = await fetchImpl(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${host.apiKey}`,
        "Content-Type": "application/json",
        ...(host.headers ?? {}),
      },
      body: JSON.stringify({
        model: host.model,
        input: inputs,
        ...(baseUrl.includes("openrouter.ai") ? { provider: OPENROUTER_PRIVATE_ROUTE } : {}),
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn("[embeddings] API failed:", res.status, errText.slice(0, 200));
      throw new EmbeddingHttpError(res.status);
    }

    const data = await res.json();

    // The provider has answered, so the call is paid whatever happens to the vectors below: write the cost first.
    if (config.onUsage) {
      try {
        await config.onUsage(readEmbeddingUsage(data, host.model, inputs));
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
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function reportHost(config: EmbeddingApiConfig, outcome: EmbeddingHostOutcome): Promise<void> {
  try {
    await config.onHostOutcome?.(outcome);
  } catch (e) {
    console.warn("[embeddings] host outcome handler failed:", e);
  }
}

/** Create embeddings for one or more texts: Cloud.ru first when given, OpenRouter otherwise or as the reserve. */
export async function createEmbeddings(
  texts: string[],
  config: EmbeddingApiConfig
): Promise<number[][]> {
  if (!texts.length) return [];

  const inputs = texts.map(normalizeInput);
  const openrouter: HostRequest | null = config.apiKey
    ? {
        baseUrl: config.baseUrl ?? "https://openrouter.ai/api/v1",
        apiKey: config.apiKey,
        model: EMBEDDING_MODEL,
        headers: config.extraHeaders,
      }
    : null;

  // Cloud.ru has this one model only: with another model set, the vectors come from the other host as before.
  const cloudru: HostRequest | null = config.cloudru && EMBEDDING_MODEL === DEFAULT_EMBEDDING_MODEL
    ? {
        baseUrl: CLOUDRU_BASE_URL,
        apiKey: config.cloudru.apiKey,
        model: CLOUDRU_EMBEDDING_MODEL,
        timeoutMs: config.cloudru.timeoutMs ?? CLOUDRU_EMBED_TIMEOUT_MS,
      }
    : null;

  if (!cloudru) {
    if (!openrouter) throw new Error("embeddings_no_host");
    return await requestVectors(inputs, openrouter, config);
  }

  const now = Date.now();
  let refusedStatus: 401 | 402 | 403 | undefined;
  let switchedBecause: SwitchReason;

  // Without a reserve Cloud.ru is asked even during a pause: there is nowhere else to go.
  if (!openrouter || !cloudruIsPaused(now)) {
    try {
      const vectors = await requestVectors(inputs, cloudru, config);
      resumeCloudru();
      await reportHost(config, { served: true });
      return vectors;
    } catch (e) {
      const status = e instanceof EmbeddingHttpError ? e.status : undefined;
      if (status === 401 || status === 402 || status === 403) {
        refusedStatus = status;
        pauseCloudru(now, status);
        switchedBecause = "refused";
      } else {
        console.warn("[embeddings] Cloud.ru failed:", e instanceof Error ? e.message : "unknown");
        switchedBecause = "unavailable";
      }
      if (!openrouter) {
        await reportHost(config, { served: false, ...(refusedStatus ? { refusedStatus } : {}), switchedBecause });
        throw e;
      }
    }
  } else {
    refusedStatus = cloudruLastRefusalStatus();
    switchedBecause = "paused";
  }

  const outcome = { ...(refusedStatus ? { refusedStatus } : {}), switchedBecause };
  try {
    const vectors = await requestVectors(inputs, openrouter, config);
    await reportHost(config, { served: true, ...outcome });
    return vectors;
  } catch (e) {
    await reportHost(config, { served: false, ...outcome });
    throw e;
  }
}

export async function createQueryEmbedding(
  query: string,
  config: EmbeddingApiConfig
): Promise<number[]> {
  const [vec] = await createEmbeddings([query], config);
  return vec;
}
