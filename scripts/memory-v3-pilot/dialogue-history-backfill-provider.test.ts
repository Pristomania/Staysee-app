import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildMemoryV3ExtractorRequest } from '../../supabase/functions/_shared/memoryV3/prompt.ts';
import { MEMORY_V3_DIALOGUE_SYSTEM_INSTRUCTION } from
  '../../supabase/functions/_shared/memoryV3/dialoguePrompt.ts';
import type { MemoryV3DialogueReconcileRequest } from
  '../../supabase/functions/_shared/memoryV3/dialoguePrompt.ts';
import { createOpenRouterAdapter } from './openrouter-adapter.mjs';
import { createMemoryV3DialogueOpenRouterAdapter } from
  '../../supabase/functions/_shared/memoryV3/dialogueTransport.ts';
import {
  LIFECYCLE_HISTORY_FALLBACK_MODEL,
  LIFECYCLE_HISTORY_MODEL_ROUTE,
  LIFECYCLE_HISTORY_PRIMARY_MODEL,
} from './lifecycle-history-backfill-profile.ts';
import { createDialogueHistoryRoutedAdapters } from
  './dialogue-history-backfill-provider.ts';

const API_KEY = 'test-key';
const RAW_SENTINEL = 'RAW_HISTORY_PROVIDER_SENTINEL';
const ROUTE = [...LIFECYCLE_HISTORY_MODEL_ROUTE];
const EXTRACTED = {
  layerDecisions: [
    { kind: 'event', decision: 'omit', itemRefs: [] },
    { kind: 'recurrence', decision: 'omit', itemRefs: [] },
    { kind: 'hypothesis', decision: 'omit', itemRefs: [] },
  ],
  items: [],
  evidence: [],
};
const RECONCILED = { operations: [] };

function extractorRequest() {
  return buildMemoryV3ExtractorRequest({
    caseId: 'memory-v3-shadow:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002',
    messages: [{
      id: '00000000-0000-4000-8000-000000000003',
      role: 'user',
      text: 'Синтетический тестовый факт.',
      createdAt: '2026-09-20T10:00:00.000Z',
    }],
  });
}

function reconcilerRequest(): MemoryV3DialogueReconcileRequest {
  return {
    system: MEMORY_V3_DIALOGUE_SYSTEM_INSTRUCTION,
    input: {
      schemaVersion: 'memory-v3-dialogue-reconcile-request-v1',
      userLanguage: 'ru',
      session: {
        conversationId: '00000000-0000-4000-8000-000000000002',
        sourceLastMessageId: '00000000-0000-4000-8000-000000000003',
        sourceLastCreatedAt: '2026-09-20T10:00:00.000Z',
      },
      messages: [{
        id: '00000000-0000-4000-8000-000000000003',
        role: 'user',
        text: 'Синтетический тестовый факт.',
        createdAt: '2026-09-20T10:00:00.000Z',
      }],
      currentItems: [],
      candidates: [],
    },
  };
}

function providerBody(model: string, content: unknown) {
  return {
    id: 'synthetic-response',
    object: 'chat.completion',
    created: 1,
    model,
    provider: 'synthetic',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      native_finish_reason: 'STOP',
      message: {
        role: 'assistant',
        content: JSON.stringify(content),
        refusal: null,
      },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 25, cost: 0.0001 },
  };
}

function trackedResponse(body: unknown, status = 200) {
  let textCalls = 0;
  return {
    status,
    async text() {
      textCalls += 1;
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    get textCalls() { return textCalls; },
  };
}

function recordingFetch(responseFactory: () => unknown | Promise<unknown>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return await responseFactory() as Response;
  };
  return Object.assign(fetchImpl as typeof fetch, { calls });
}

function routedBody(fetchImpl: ReturnType<typeof recordingFetch>, index = 0) {
  return JSON.parse(String(fetchImpl.calls[index].init.body)) as Record<string, unknown>;
}

function assertRouteAndPrivacy(body: Record<string, unknown>) {
  assert.deepEqual(body.models, ROUTE);
  assert.equal(Object.hasOwn(body, 'model'), false);
  assert.deepEqual(body.provider, {
    allow_fallbacks: true,
    require_parameters: true,
    data_collection: 'deny',
    zdr: true,
  });
}

async function captureError(action: () => Promise<unknown>) {
  let caught: unknown;
  try { await action(); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message.includes(RAW_SENTINEL), false);
  assert.equal(JSON.stringify(caught).includes(RAW_SENTINEL), false);
  assert.equal('cause' in caught, false);
  return caught;
}

describe('history-only OpenRouter model route (dialogue scope)', () => {
  it('routes extractor once, preserves privacy, reads the response once, and records fallback', async () => {
    const response = trackedResponse(providerBody(LIFECYCLE_HISTORY_FALLBACK_MODEL, EXTRACTED));
    const fetchImpl = recordingFetch(() => response);
    const { extractorAdapter } = createDialogueHistoryRoutedAdapters({ apiKey: API_KEY, fetchImpl });

    const result = await extractorAdapter(extractorRequest());

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(response.textCalls, 1);
    assertRouteAndPrivacy(routedBody(fetchImpl));
    assert.equal(routedBody(fetchImpl).max_tokens, 4_096);
    assert.equal(result.content, JSON.stringify(EXTRACTED));
    assert.equal(result.resolvedModel, LIFECYCLE_HISTORY_FALLBACK_MODEL);
  });

  it('routes reconciler once, preserves privacy, reads the response once, and records fallback', async () => {
    const response = trackedResponse(providerBody(LIFECYCLE_HISTORY_FALLBACK_MODEL, RECONCILED));
    const fetchImpl = recordingFetch(() => response);
    const { reconcilerAdapter } = createDialogueHistoryRoutedAdapters({ apiKey: API_KEY, fetchImpl });

    const result = await reconcilerAdapter(reconcilerRequest());

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(response.textCalls, 1);
    assertRouteAndPrivacy(routedBody(fetchImpl));
    assert.equal(routedBody(fetchImpl).max_tokens, 1_200);
    assert.equal(result.rawContent, JSON.stringify(RECONCILED));
    assert.equal(result.resolvedModel, LIFECYCLE_HISTORY_FALLBACK_MODEL);
  });

  it('records primary resolution and clears observer state between sequential calls', async () => {
    const models = [LIFECYCLE_HISTORY_PRIMARY_MODEL, LIFECYCLE_HISTORY_FALLBACK_MODEL];
    let responseIndex = 0;
    const responses = models.map((model) => trackedResponse(providerBody(model, EXTRACTED)));
    const fetchImpl = recordingFetch(() => responses[responseIndex++]);
    const { extractorAdapter } = createDialogueHistoryRoutedAdapters({ apiKey: API_KEY, fetchImpl });

    const first = await extractorAdapter(extractorRequest());
    const second = await extractorAdapter(extractorRequest());

    assert.equal(first.resolvedModel, LIFECYCLE_HISTORY_PRIMARY_MODEL);
    assert.equal(second.resolvedModel, LIFECYCLE_HISTORY_FALLBACK_MODEL);
    assert.equal(fetchImpl.calls.length, 2);
    assert.deepEqual(responses.map((response) => response.textCalls), [1, 1]);
  });

  it('records primary reconciliation through the same one-request route', async () => {
    const response = trackedResponse(providerBody(LIFECYCLE_HISTORY_PRIMARY_MODEL, RECONCILED));
    const fetchImpl = recordingFetch(() => response);
    const { reconcilerAdapter } = createDialogueHistoryRoutedAdapters({ apiKey: API_KEY, fetchImpl });
    const result = await reconcilerAdapter(reconcilerRequest());
    assert.equal(result.resolvedModel, LIFECYCLE_HISTORY_PRIMARY_MODEL);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(response.textCalls, 1);
    assertRouteAndPrivacy(routedBody(fetchImpl));
  });

  it('matches existing request bodies except for the deterministic model-to-models substitution', async () => {
    let extractorBaseline: Record<string, unknown> | undefined;
    const extractor = createOpenRouterAdapter({
      transport: async (request: { body: Record<string, unknown> }) => {
        extractorBaseline = structuredClone(request.body);
        return { status: 200, body: providerBody(LIFECYCLE_HISTORY_PRIMARY_MODEL, EXTRACTED) };
      },
      apiKey: API_KEY,
      model: LIFECYCLE_HISTORY_PRIMARY_MODEL,
      maxOutputTokens: 4_096,
      reasoningEffort: 'low',
      responseContract: 'v2-layered',
      allowFallbacks: true,
      maxTokensParameter: 'max_tokens',
    });
    await extractor(extractorRequest());

    const dialogueFetch = recordingFetch(() => new Response(JSON.stringify(
      providerBody(LIFECYCLE_HISTORY_PRIMARY_MODEL, RECONCILED),
    ), { status: 200 }));
    await createMemoryV3DialogueOpenRouterAdapter({ apiKey: API_KEY, fetchImpl: dialogueFetch })(
      reconcilerRequest(),
    );
    const dialogueBaseline = routedBody(dialogueFetch);

    const routedExtractorFetch = recordingFetch(() => trackedResponse(
      providerBody(LIFECYCLE_HISTORY_PRIMARY_MODEL, EXTRACTED),
    ));
    const routedDialogueFetch = recordingFetch(() => trackedResponse(
      providerBody(LIFECYCLE_HISTORY_PRIMARY_MODEL, RECONCILED),
    ));
    await createDialogueHistoryRoutedAdapters({ apiKey: API_KEY, fetchImpl: routedExtractorFetch })
      .extractorAdapter(extractorRequest());
    await createDialogueHistoryRoutedAdapters({ apiKey: API_KEY, fetchImpl: routedDialogueFetch })
      .reconcilerAdapter(reconcilerRequest());

    for (const [baseline, actual] of [
      [extractorBaseline!, routedBody(routedExtractorFetch)],
      [dialogueBaseline, routedBody(routedDialogueFetch)],
    ] as const) {
      const expected = structuredClone(baseline);
      delete expected.model;
      expected.models = ROUTE;
      assert.deepEqual(actual, expected);
    }
  });

  it('fails closed for missing, unknown, malformed, or top-level-error response models', async () => {
    const bodies: unknown[] = [
      { ...providerBody(LIFECYCLE_HISTORY_PRIMARY_MODEL, EXTRACTED), model: undefined },
      providerBody(`unknown-${RAW_SENTINEL}`, EXTRACTED),
      `not-json-${RAW_SENTINEL}`,
      { error: { message: RAW_SENTINEL } },
    ];
    for (const body of bodies) {
      const response = trackedResponse(body);
      const fetchImpl = recordingFetch(() => response);
      const { extractorAdapter } = createDialogueHistoryRoutedAdapters({ apiKey: API_KEY, fetchImpl });
      await captureError(() => extractorAdapter(extractorRequest()));
      assert.equal(fetchImpl.calls.length, 1);
      assert.equal(response.textCalls, 1);
    }
  });

  it('does not execute an accessor hidden in a non-string response body', async () => {
    let getterCalls = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'model', {
      enumerable: true,
      get() { getterCalls += 1; return RAW_SENTINEL; },
    });
    const response = {
      status: 200,
      async text() { return hostile as unknown as string; },
    };
    const fetchImpl = recordingFetch(() => response);
    const { extractorAdapter } = createDialogueHistoryRoutedAdapters({ apiKey: API_KEY, fetchImpl });
    await captureError(() => extractorAdapter(extractorRequest()));
    assert.equal(getterCalls, 0);
  });

  it('does not read an HTTP error body and does not retry a rejected inner fetch', async () => {
    const httpResponse = trackedResponse(RAW_SENTINEL, 403);
    const httpFetch = recordingFetch(() => httpResponse);
    await captureError(() => createDialogueHistoryRoutedAdapters({ apiKey: API_KEY, fetchImpl: httpFetch })
      .extractorAdapter(extractorRequest()));
    assert.equal(httpFetch.calls.length, 1);
    assert.equal(httpResponse.textCalls, 0);

    const rejectingFetch = recordingFetch(() => Promise.reject(new Error(RAW_SENTINEL)));
    await captureError(() => createDialogueHistoryRoutedAdapters({ apiKey: API_KEY, fetchImpl: rejectingFetch })
      .reconcilerAdapter(reconcilerRequest()));
    assert.equal(rejectingFetch.calls.length, 1);
  });

  it('rejects hostile configuration without executing getters or calling fetch', () => {
    let getterCalls = 0;
    const fetchImpl = recordingFetch(() => trackedResponse({}));
    const hostile = { apiKey: API_KEY, fetchImpl };
    Object.defineProperty(hostile, 'apiKey', {
      enumerable: true,
      get() { getterCalls += 1; return RAW_SENTINEL; },
    });
    assert.throws(
      () => createDialogueHistoryRoutedAdapters(hostile as never),
      /^MemoryV3DialogueHistoryProviderError:/,
    );
    assert.equal(getterCalls, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });
});
