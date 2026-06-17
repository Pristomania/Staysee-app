/**
 * Calm fallback classifier + send result guards.
 * Run: npx tsx src/lib/ai/client.cases.test.ts
 */

import {
  classifyHttp200Content,
  isServerCalmFallback,
  SERVER_CALM_ERROR_TEXTS,
} from './calmFallback';
import { isAiSendSuccess, type AiSendResult } from './sendResult';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ── Real model content ───────────────────────────────────────────────────────

assert(
  isAiSendSuccess({ status: 'success', content: 'Привет! Как дела?' }),
  'model reply is success',
);

const model200 = classifyHttp200Content('Привет! Как дела?');
assert(model200.status === 'success', 'HTTP 200 model text => success');
assert(
  isAiSendSuccess({ status: 'success', content: model200.content! }),
  'classified model text is success',
);

// ── Server CALM_ERRORS on HTTP 200 ───────────────────────────────────────────

const unavailable = SERVER_CALM_ERROR_TEXTS[0];
assert(isServerCalmFallback(unavailable), 'unavailable is calm fallback');

const calm200 = classifyHttp200Content(unavailable);
assert(calm200.status === 'server_fallback', 'HTTP 200 unavailable => server_fallback');
assert(
  !isAiSendSuccess({
    status: 'server_fallback',
    userMessage: calm200.userMessage,
  }),
  'server_fallback is not success',
);

// ── HTTP 429 duplicate (handled in client as server_duplicate) ───────────────

assert(
  !isAiSendSuccess({
    status: 'server_duplicate',
    userMessage: SERVER_CALM_ERROR_TEXTS[3],
  }),
  '429 duplicate is not success',
);

// ── Network / empty ──────────────────────────────────────────────────────────

assert(
  !isAiSendSuccess({
    status: 'network_error',
    userMessage: SERVER_CALM_ERROR_TEXTS[0],
  }),
  'network error is not success',
);

assert(
  !isAiSendSuccess({ status: 'rate_limit', userMessage: SERVER_CALM_ERROR_TEXTS[1] }),
  'rate limit is not success',
);

assert(
  !isAiSendSuccess({ status: 'empty_response', userMessage: 'x' }),
  'empty is not success',
);

assert(
  !isAiSendSuccess({ status: 'success', content: '   ' }),
  'whitespace-only is not success',
);

console.log('client.cases.test.ts — all passed');
