/**
 * Calm fallback classifier + send result guards.
 * Run: npx tsx src/lib/ai/client.cases.test.ts
 *
 * Also contracts the authorized chat transport contract
 * (src/lib/ai/clientTransport.ts).
 */

import {
  classifyHttp200Content,
  isServerCalmFallback,
  SERVER_CALM_ERROR_TEXTS,
} from './calmFallback';
import { isAiSendSuccess, type AiSendResult } from './sendResult';
import { sendAuthorizedChatRequest } from './clientTransport.ts';

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

// ── Authorized chat transport contract ───────────────────────────────────────

const ACCESS_TOKEN = 'test-access-token';
const ANON_KEY = 'test-anon-key';
const BASE_URL = 'https://example.test/supabase';

type TransportFetchCall = {
  input: string;
  init?: RequestInit;
};

function makeTransportDeps(opts: {
  accessToken: string | null;
  fetchResponse?: Response;
}) {
  const getAccessTokenCalls: number[] = [];
  const getPublicConfigCalls: number[] = [];
  const fetchCalls: TransportFetchCall[] = [];

  const deps = {
    getAccessToken: async () => {
      getAccessTokenCalls.push(1);
      return opts.accessToken;
    },
    getPublicConfig: () => {
      getPublicConfigCalls.push(1);
      return { url: BASE_URL, anonKey: ANON_KEY };
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        input: String(input),
        init,
      });
      return opts.fetchResponse ?? new Response('{}', { status: 200 });
    }) as typeof fetch,
  };

  return { deps, getAccessTokenCalls, getPublicConfigCalls, fetchCalls };
}

const transportBody = {
  message: 'привет',
  conversationId: 'conv-1',
  userId: 'user-1',
  requestId: 'req-1',
};

// 1. No access token → no fetch / no config, network_error
{
  const { deps, getAccessTokenCalls, getPublicConfigCalls, fetchCalls } =
    makeTransportDeps({ accessToken: null });

  const result = await sendAuthorizedChatRequest({
    body: transportBody,
    signal: undefined,
    deps,
  });

  assert(result.ok === false, '1.no_token: ok must be false');
  if (!result.ok) {
    const aiResult: AiSendResult = result.result;
    assert(
      aiResult.status === 'network_error',
      `1.no_token: status expected network_error, got ${aiResult.status}`,
    );
    assert(
      typeof aiResult.userMessage === 'string' && aiResult.userMessage.length > 0,
      '1.no_token: userMessage required',
    );
  }
  assert(getAccessTokenCalls.length === 1, '1.no_token: getAccessToken once');
  assert(getPublicConfigCalls.length === 0, '1.no_token: getPublicConfig unused');
  assert(fetchCalls.length === 0, '1.no_token: fetch unused');
  console.log('✓ no access token → network_error, no fetch/config');
}

// 2. No token even when anonKey exists in fake config → still no Bearer/anon misuse
{
  const { deps, getAccessTokenCalls, getPublicConfigCalls, fetchCalls } =
    makeTransportDeps({ accessToken: null });

  const result = await sendAuthorizedChatRequest({
    body: transportBody,
    signal: undefined,
    deps,
  });

  assert(result.ok === false, '2.anon_unused: ok must be false');
  if (!result.ok) {
    assert(
      result.result.status === 'network_error',
      '2.anon_unused: status network_error',
    );
  }
  assert(getAccessTokenCalls.length === 1, '2.anon_unused: getAccessToken once');
  assert(
    getPublicConfigCalls.length === 0,
    '2.anon_unused: getPublicConfig unused (request forbidden without token)',
  );
  assert(fetchCalls.length === 0, '2.anon_unused: fetch unused');
  assert(
    !fetchCalls.some((c) =>
      String(c.init?.headers && JSON.stringify(c.init.headers)).includes(ANON_KEY),
    ),
    '2.anon_unused: anon key never used as Bearer',
  );
  console.log('✓ anon key present in fake config but unused without token');
}

// 3. Valid access token → one authorized fetch
{
  const { deps, getAccessTokenCalls, getPublicConfigCalls, fetchCalls } =
    makeTransportDeps({
      accessToken: ACCESS_TOKEN,
      fetchResponse: new Response(JSON.stringify({ content: 'ok' }), {
        status: 200,
      }),
    });

  const result = await sendAuthorizedChatRequest({
    body: transportBody,
    signal: undefined,
    deps,
  });

  assert(result.ok === true, '3.token: ok must be true');
  if (result.ok) {
    assert(result.response instanceof Response, '3.token: response is Response');
    assert(result.response.status === 200, '3.token: response status 200');
  }
  assert(getAccessTokenCalls.length === 1, '3.token: getAccessToken once');
  assert(getPublicConfigCalls.length === 1, '3.token: getPublicConfig once');
  assert(fetchCalls.length === 1, '3.token: fetch once');

  const call = fetchCalls[0]!;
  assert(
    call.input === `${BASE_URL}/functions/v1/staysee-chat`,
    `3.token: URL expected staysee-chat, got ${call.input}`,
  );
  assert(call.init?.method === 'POST', '3.token: method POST');

  const headers = call.init?.headers as Record<string, string>;
  assert(
    headers['Authorization'] === `Bearer ${ACCESS_TOKEN}`,
    `3.token: Authorization expected Bearer access token, got ${headers['Authorization']}`,
  );
  assert(
    headers['Apikey'] === ANON_KEY,
    `3.token: Apikey expected anon key, got ${headers['Apikey']}`,
  );
  assert(
    !headers['Authorization']?.includes(ANON_KEY),
    '3.token: Bearer must not contain anon key',
  );
  assert(
    call.init?.body === JSON.stringify(transportBody),
    '3.token: body must match request object',
  );
  console.log('✓ valid token → one POST with Bearer access token');
}

// ── Integration: sendAiMessage + ChatTransportDeps ───────────────────────────
// Dynamic import isolates the integration block from transport unit cases.

{
  console.log('… loading sendAiMessage via dynamic import');
  const { sendAiMessage } = await import('./client.ts');

  // I1. No access token → network_error, no config/fetch
  {
    const getPublicConfigCalls: number[] = [];
    const fetchCalls: TransportFetchCall[] = [];
    const deps = {
      getAccessToken: async () => null,
      getPublicConfig: () => {
        getPublicConfigCalls.push(1);
        return { url: BASE_URL, anonKey: ANON_KEY };
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ input: String(input), init });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    };

    const result: AiSendResult = await sendAiMessage(
      {
        message: 'integration-no-token',
        userId: 'user-int-no-token',
        conversationId: 'conv-int-1',
        requestId: 'req-int-1',
      },
      deps,
    );

    assert(result.status === 'network_error', 'I1: status network_error');
    assert(getPublicConfigCalls.length === 0, 'I1: getPublicConfig unused');
    assert(fetchCalls.length === 0, 'I1: fetch unused');
    console.log('✓ sendAiMessage no token → network_error, no fetch');
  }

  // I2. No token; anon present in fake config → still no Bearer/anon misuse
  {
    const fetchCalls: TransportFetchCall[] = [];
    const deps = {
      getAccessToken: async () => null,
      getPublicConfig: () => ({ url: BASE_URL, anonKey: ANON_KEY }),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ input: String(input), init });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    };

    const result: AiSendResult = await sendAiMessage(
      {
        message: 'integration-anon-unused',
        userId: 'user-int-anon',
        conversationId: 'conv-int-2',
        requestId: 'req-int-2',
      },
      deps,
    );

    assert(result.status === 'network_error', 'I2: status network_error');
    assert(fetchCalls.length === 0, 'I2: fetch unused');
    assert(
      !fetchCalls.some((c) =>
        String(c.init?.headers && JSON.stringify(c.init.headers)).includes(
          ANON_KEY,
        ),
      ),
      'I2: anon key never used as Bearer',
    );
    console.log('✓ sendAiMessage ignores anon as Bearer without token');
  }

  // I3. Valid token → success via one authorized fetch
  {
    const fetchCalls: TransportFetchCall[] = [];
    const deps = {
      getAccessToken: async () => ACCESS_TOKEN,
      getPublicConfig: () => ({ url: BASE_URL, anonKey: ANON_KEY }),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ input: String(input), init });
        return new Response(JSON.stringify({ content: 'ответ' }), {
          status: 200,
        });
      }) as typeof fetch,
    };

    const options = {
      message: 'integration-ok-unique',
      userId: 'user-int-ok',
      conversationId: 'conv-int-3',
      requestId: 'req-int-3',
    };

    const result: AiSendResult = await sendAiMessage(options, deps);

    assert(result.status === 'success', 'I3: status success');
    assert(result.content === 'ответ', 'I3: content from response');
    assert(fetchCalls.length === 1, 'I3: fetch once');

    const call = fetchCalls[0]!;
    const headers = call.init?.headers as Record<string, string>;
    assert(
      headers['Authorization'] === `Bearer ${ACCESS_TOKEN}`,
      `I3: Authorization expected Bearer access token, got ${headers['Authorization']}`,
    );
    assert(
      !headers['Authorization']?.includes(ANON_KEY),
      'I3: Bearer must not contain anon key',
    );
    assert(headers['Apikey'] === ANON_KEY, 'I3: Apikey is anon key');

    const parsedBody = JSON.parse(String(call.init?.body)) as Record<
      string,
      unknown
    >;
    assert(parsedBody.message === options.message, 'I3: body.message');
    assert(
      parsedBody.conversationId === options.conversationId,
      'I3: body.conversationId',
    );
    assert(parsedBody.userId === options.userId, 'I3: body.userId');
    assert(parsedBody.requestId === options.requestId, 'I3: body.requestId');
    console.log('✓ sendAiMessage with token → success, Bearer access token');
  }
}

console.log('client.cases.test.ts — all passed');
