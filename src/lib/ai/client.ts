import { supabase } from '../supabase';
import { resolveSupabasePublicConfig } from '../supabaseEnv';
import type { TimeGapMeta } from '../timeGap';
import { classifyHttp200Content } from './calmFallback';
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
export async function sendAiMessage(options: SendMessageOptions): Promise<AiSendResult> {
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
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    const { url: supabaseUrl, anonKey } = resolveSupabasePublicConfig();

    const body: Record<string, unknown> = { message };
    if (requestId) body.requestId = requestId;
    if (conversationId) body.conversationId = conversationId;
    if (userId) body.userId = userId;
    if (options.provider) body.provider = options.provider;
    if (options.model) body.model = options.model;
    if (options.timeGap) body.timeGap = options.timeGap;

    let response: Response;
    try {
      response = await fetch(`${supabaseUrl}/functions/v1/staysee-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token ?? anonKey}`,
          Apikey: anonKey,
        },
        body: JSON.stringify(body),
        signal,
      });
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
