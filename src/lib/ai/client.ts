import { supabase } from '../supabase';
import { resolveSupabasePublicConfig } from '../supabaseEnv';
import type { TimeGapMeta } from '../timeGap';

// ── Calm fallback replies (shown when edge function is unreachable) ────────────

const FALLBACK_REPLIES = [
  'Сейчас не могу ответить. Попробуй чуть позже.',
  'Что-то пошло не так. Я здесь, но попробуй ещё раз через момент.',
];

function fallbackReply(): string {
  return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)];
}

// ── Duplicate prevention ──────────────────────────────────────────────────────
// Tracks in-flight requests so a second identical call (double-tap, StrictMode
// double-invoke, race condition) is silently dropped on the client side before
// it even reaches the edge function.

const inFlight = new Set<string>();

function makeClientKey(userId: string, message: string): string {
  return `${userId}::${message.slice(0, 120)}`;
}

// ── Idempotency key ───────────────────────────────────────────────────────────
// Passed to the edge function so server-side dedup also works.

function makeRequestId(userId: string, message: string): string {
  return `${userId}-${Date.now()}-${message.slice(0, 40).replace(/\s+/g, '_')}`;
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
  provider?: string;
  model?: string;
  /** Pause since last user message — used in system prompt only. */
  timeGap?: TimeGapMeta;
  /** Abort in-flight fetch (Stop generation). */
  signal?: AbortSignal;
}

/**
 * Sends one message to the StaySee AI edge function.
 *
 * - History, memory, and context are fetched server-side (Layer 4).
 * - In-flight dedup prevents double-sends from double-taps or StrictMode.
 * - A unique requestId is sent so the server can also deduplicate.
 * - All errors return a calm human-readable string — never a technical message.
 */
export async function sendAiMessage(options: SendMessageOptions): Promise<string> {
  const { message, conversationId, userId, signal } = options;

  if (signal?.aborted) throw new AiRequestAborted();

  // Client-side duplicate guard
  const clientKey = userId ? makeClientKey(userId, message) : null;
  if (clientKey) {
    if (inFlight.has(clientKey)) return '';
    inFlight.add(clientKey);
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    const { url: supabaseUrl, anonKey } = resolveSupabasePublicConfig();

    const requestId = userId ? makeRequestId(userId, message) : undefined;

    const body: Record<string, unknown> = { message, requestId };
    if (conversationId) body.conversationId = conversationId;
    if (userId) body.userId = userId;
    if (options.provider) body.provider = options.provider;
    if (options.model) body.model = options.model;
    if (options.timeGap) body.timeGap = options.timeGap;

    const response = await fetch(`${supabaseUrl}/functions/v1/staysee-chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token ?? anonKey}`,
        'Apikey': anonKey,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (signal?.aborted) throw new AiRequestAborted();

    // Rate limit / suspension — server already returns a calm message as `content`
    if (response.status === 429) {
      const data = await response.json().catch(() => ({}));
      return data.content || FALLBACK_REPLIES[0];
    }

    if (!response.ok) return fallbackReply();

    const data = await response.json();
    // Empty string from dedup-on-server should not replace existing content
    if (!data.content) return fallbackReply();
    return data.content as string;
  } catch (err) {
    if (isAiRequestAborted(err) || signal?.aborted) throw new AiRequestAborted();
    return fallbackReply();
  } finally {
    if (clientKey) inFlight.delete(clientKey);
  }
}
