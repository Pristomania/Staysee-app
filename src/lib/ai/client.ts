import type { TimeGapMeta } from '../timeGap';
import { classifyHttp200Content } from './calmFallback';
import {
  sendAuthorizedChatRequest,
  type ChatTransportDeps,
} from './clientTransport';
import type { AiSendResult } from './sendResult';
export type { AiSendResult, AiSendStatus } from './sendResult';
export { isAiSendSuccess } from './sendResult';
export { isServerCalmFallback, classifyHttp200Content } from './calmFallback';

// ── Calm fallback replies (UI only — never persisted as AI messages) ───────────

export const AI_FALLBACK_REPLIES = [
  'Сейчас не могу ответить. Попробуй чуть позже.',
  'Что-то пошло не так. Я здесь, но попробуй ещё раз через момент.',
] as const;

const SERVER_DUPLICATE_SNIPPET = 'уже отправляется';

function fallbackReply(): string {
  return AI_FALLBACK_REPLIES[Math.floor(Math.random() * AI_FALLBACK_REPLIES.length)];
}

// ── Duplicate prevention ──────────────────────────────────────────────────────

const inFlight = new Set<string>();

function makeClientKey(userId: string, message: string): string {
  return `${userId}::${message.slice(0, 120)}`;
}

let resolveSupabasePublicConfig: ChatTransportDeps['getPublicConfig'] | null = null;

const defaultChatTransportDeps: ChatTransportDeps = {
  getAccessToken: async () => {
    const { supabase } = await import('../supabase');
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token ?? null;
    if (typeof token === 'string' && token.trim()) {
      const env = await import('../supabaseEnv');
      resolveSupabasePublicConfig = env.resolveSupabasePublicConfig;
    }
    return token;
  },
  getPublicConfig: () => {
    if (!resolveSupabasePublicConfig) {
      throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
    }
    return resolveSupabasePublicConfig();
  },
  fetch: (input, init) => globalThis.fetch(input, init),
};

// ── Public API ────────────────────────────────────────────────────────────────

export class AiRequestAborted extends Error {
  constructor() {
    super('AI request aborted');
    this.name = 'AiRequestAborted';
  }
}

export function isAiRequestAborted(err: unknown): boolean {
  if (err instanceof AiRequestAborted) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return false;
}

export interface SendMessageOptions {
  message: string;
  conversationId?: string;
  userId?: string;
  /** Stable turn id — reused on retry for the same user message. */
  requestId?: string;
  provider?: string;
  model?: string;
  timeGap?: TimeGapMeta;
  signal?: AbortSignal;
}

/**
 * Sends one message to the staysee-chat edge function.
 * Returns a discriminated result — callers must not persist non-success content as AI.
 */
export async function sendAiMessage(
  options: SendMessageOptions,
  deps: ChatTransportDeps = defaultChatTransportDeps,
): Promise<AiSendResult> {
  const { message, conversationId, userId, requestId, signal } = options;

  if (signal?.aborted) throw new AiRequestAborted();

  const clientKey = userId ? makeClientKey(userId, message) : null;
  if (clientKey) {
    if (inFlight.has(clientKey)) {
      return {
        status: 'in_flight_duplicate',
        userMessage: 'Сообщение уже отправляется. Подожди секунду.',
      };
    }
    inFlight.add(clientKey);
  }

  try {
    const body: Record<string, unknown> = { message };
    if (requestId) body.requestId = requestId;
    if (conversationId) body.conversationId = conversationId;
    if (userId) body.userId = userId;
    if (options.provider) body.provider = options.provider;
    if (options.model) body.model = options.model;
    if (options.timeGap) body.timeGap = options.timeGap;

    let response: Response;
    try {
      const transportResult = await sendAuthorizedChatRequest({
        body,
        signal,
        deps,
      });
      if (!transportResult.ok) {
        return transportResult.result;
      }
      response = transportResult.response;
    } catch {
      return {
        status: 'network_error',
        userMessage: fallbackReply(),
      };
    }

    if (signal?.aborted) throw new AiRequestAborted();

    if (response.status === 429) {
      const data = await response.json().catch(() => ({}));
      const calm = typeof data.content === 'string' ? data.content : '';
      if (calm.includes(SERVER_DUPLICATE_SNIPPET)) {
        return { status: 'server_duplicate', userMessage: calm };
      }
      return {
        status: 'rate_limit',
        userMessage: calm || AI_FALLBACK_REPLIES[0],
      };
    }

    if (!response.ok) {
      return {
        status: 'http_error',
        userMessage: fallbackReply(),
      };
    }

    const data = await response.json().catch(() => ({}));
    const content = typeof data.content === 'string' ? data.content : '';
    if (!content.trim()) {
      return {
        status: 'empty_response',
        userMessage: fallbackReply(),
      };
    }

    const classified = classifyHttp200Content(content);
    if (classified.status === 'server_fallback') {
      return {
        status: 'server_fallback',
        userMessage: classified.userMessage,
      };
    }

    return { status: 'success', content: classified.content! };
  } catch (err) {
    if (isAiRequestAborted(err) || signal?.aborted) throw new AiRequestAborted();
    return {
      status: 'network_error',
      userMessage: fallbackReply(),
    };
  } finally {
    if (clientKey) inFlight.delete(clientKey);
  }
}
