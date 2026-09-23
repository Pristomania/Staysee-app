import { isProxy } from 'node:util/types';

import {
  LIFECYCLE_HISTORY_BACKFILL_MAX_OUTPUT_TOKENS_PER_CALL,
  LIFECYCLE_HISTORY_MODEL_ROUTE,
  LIFECYCLE_HISTORY_PRIMARY_MODEL,
  type LifecycleHistoryResolvedModel,
} from './lifecycle-history-backfill-profile.ts';
import { createOpenRouterAdapter } from './openrouter-adapter.mjs';
import { createOpenRouterFetchTransport } from './openrouter-fetch-transport.mjs';
import type {
  MemoryV3ModelAdapter,
  MemoryV3TransportResult,
} from '../../supabase/functions/_shared/memoryV3/transport.ts';
import {
  createMemoryV3DialogueOpenRouterAdapter,
  type MemoryV3DialogueModelAdapter,
  type MemoryV3DialogueTransportResult,
} from '../../supabase/functions/_shared/memoryV3/dialogueTransport.ts';

export type DialogueHistoryExtractorResult = MemoryV3TransportResult & {
  resolvedModel: LifecycleHistoryResolvedModel;
};

export type DialogueHistoryReconcilerResult = MemoryV3DialogueTransportResult & {
  resolvedModel: LifecycleHistoryResolvedModel;
};

export type DialogueHistoryExtractorAdapter = (
  request: Parameters<MemoryV3ModelAdapter>[0],
) => Promise<DialogueHistoryExtractorResult>;

export type DialogueHistoryReconcilerAdapter = (
  request: Parameters<MemoryV3DialogueModelAdapter>[0],
) => Promise<DialogueHistoryReconcilerResult>;

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const CONFIG_FIELDS = ['apiKey', 'fetchImpl'] as const;
const INIT_FIELDS = ['method', 'headers', 'body', 'signal'] as const;
const HEADER_FIELDS = ['Authorization', 'Content-Type'] as const;
const PROVIDER_FIELDS = [
  'allow_fallbacks',
  'require_parameters',
  'data_collection',
  'zdr',
] as const;
const OWN_ERRORS = new WeakSet<object>();

function makeError(): Error {
  const error = new Error('[memory-v3:dialogue-history-provider] value is invalid');
  error.name = 'MemoryV3DialogueHistoryProviderError';
  OWN_ERRORS.add(error);
  return error;
}

function fail(): never {
  throw makeError();
}

function boundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (typeof error === 'object' && error !== null && OWN_ERRORS.has(error)) throw error;
    throw makeError();
  }
}

function projectRecord(
  value: unknown,
  exactFields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value)) fail();
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    if (Array.isArray(value)) fail();
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail();
  }
  if (prototype !== Object.prototype && prototype !== null) fail();
  if (
    keys.length !== exactFields.length ||
    keys.some((key) => typeof key !== 'string' || !exactFields.includes(key))
  ) fail();
  const projected: Record<string, unknown> = {};
  for (const field of exactFields) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); } catch { fail(); }
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
    Object.defineProperty(projected, field, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return projected;
}

function parseRequestBody(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') fail();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail(); }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) fail();
  return parsed as Record<string, unknown>;
}

function assertHeaders(value: unknown): void {
  const headers = projectRecord(value, HEADER_FIELDS);
  if (
    typeof headers.Authorization !== 'string' ||
    !headers.Authorization.startsWith('Bearer ') ||
    headers.Authorization.slice(7).trim().length === 0 ||
    headers['Content-Type'] !== 'application/json'
  ) fail();
}

function rewriteBody(raw: unknown): string {
  const body = parseRequestBody(raw);
  if (
    body.model !== LIFECYCLE_HISTORY_PRIMARY_MODEL ||
    Object.hasOwn(body, 'models')
  ) fail();
  const provider = projectRecord(body.provider, PROVIDER_FIELDS);
  if (
    provider.allow_fallbacks !== true ||
    provider.require_parameters !== true ||
    provider.data_collection !== 'deny' ||
    provider.zdr !== true
  ) fail();
  delete body.model;
  body.models = [...LIFECYCLE_HISTORY_MODEL_ROUTE];
  return JSON.stringify(body);
}

function projectResolvedModel(value: unknown): LifecycleHistoryResolvedModel {
  if (
    value !== LIFECYCLE_HISTORY_MODEL_ROUTE[0] &&
    value !== LIFECYCLE_HISTORY_MODEL_ROUTE[1]
  ) fail();
  return value;
}

function parseResolvedModel(text: unknown): LifecycleHistoryResolvedModel {
  if (typeof text !== 'string') fail();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail(); }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) fail();
  const descriptor = Object.getOwnPropertyDescriptor(parsed, 'model');
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
  return projectResolvedModel(descriptor.value);
}

async function readRawResponse(
  raw: unknown,
): Promise<{ status: number; text: string | null }> {
  if (typeof raw !== 'object' || raw === null || isProxy(raw)) fail();
  let status: unknown;
  let readText: (() => Promise<unknown>) | undefined;
  try {
    if (raw instanceof Response) {
      const statusGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get;
      if (typeof statusGetter !== 'function') fail();
      status = statusGetter.call(raw);
      readText = () => Response.prototype.text.call(raw);
    } else {
      let prototype: object | null;
      let keys: PropertyKey[];
      let statusDescriptor: PropertyDescriptor | undefined;
      let textDescriptor: PropertyDescriptor | undefined;
      try {
        if (Array.isArray(raw)) fail();
        prototype = Object.getPrototypeOf(raw);
        keys = Reflect.ownKeys(raw);
        statusDescriptor = Object.getOwnPropertyDescriptor(raw, 'status');
        textDescriptor = Object.getOwnPropertyDescriptor(raw, 'text');
      } catch {
        fail();
      }
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        keys.some((key) => typeof key !== 'string') ||
        !statusDescriptor ||
        !statusDescriptor.enumerable ||
        !('value' in statusDescriptor) ||
        !textDescriptor ||
        !textDescriptor.enumerable ||
        !('value' in textDescriptor) ||
        typeof textDescriptor.value !== 'function'
      ) fail();
      status = statusDescriptor.value;
      readText = () => Promise.resolve(
        (textDescriptor!.value as () => unknown).call(raw),
      );
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && OWN_ERRORS.has(error)) throw error;
    fail();
  }
  if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) fail();
  if ((status as number) < 200 || (status as number) > 299) {
    return { status: status as number, text: null };
  }
  let text: unknown;
  try { text = await readText!(); } catch { fail(); }
  if (typeof text !== 'string') fail();
  return { status: status as number, text };
}

interface Observer {
  begin(): void;
  fetch: typeof fetch;
  finish(): LifecycleHistoryResolvedModel;
  clear(): void;
}

function createObserver(innerFetch: typeof fetch): Observer {
  let active = false;
  let callCount = 0;
  let resolvedModel: LifecycleHistoryResolvedModel | null = null;

  return {
    begin() {
      if (active) fail();
      active = true;
      callCount = 0;
      resolvedModel = null;
    },
    fetch: (async (url: string | URL | Request, unsafeInit?: RequestInit) => {
      if (!active || callCount !== 0 || String(url) !== OPENROUTER_URL) fail();
      const init = projectRecord(unsafeInit, INIT_FIELDS);
      if (init.method !== 'POST') fail();
      assertHeaders(init.headers);
      const rewrittenBody = rewriteBody(init.body);
      callCount += 1;

      let raw: unknown;
      try {
        raw = await innerFetch(url, {
          method: 'POST',
          headers: init.headers as HeadersInit,
          body: rewrittenBody,
          signal: init.signal as AbortSignal,
        });
      } catch {
        fail();
      }

      const response = await readRawResponse(raw);
      if (response.text === null) return new Response(null, { status: response.status });
      resolvedModel = parseResolvedModel(response.text);
      return new Response(response.text, { status: response.status });
    }) as typeof fetch,
    finish() {
      if (!active || callCount !== 1 || resolvedModel === null) fail();
      return resolvedModel;
    },
    clear() {
      active = false;
      callCount = 0;
      resolvedModel = null;
    },
  };
}

function wrapExtractor(
  observer: Observer,
  adapter: MemoryV3ModelAdapter,
): DialogueHistoryExtractorAdapter {
  return async (request) => {
    observer.begin();
    try {
      const result = await adapter(request);
      const resolvedModel = observer.finish();
      return { content: result.content, usage: result.usage, resolvedModel };
    } finally {
      observer.clear();
    }
  };
}

function wrapReconciler(
  observer: Observer,
  adapter: MemoryV3DialogueModelAdapter,
): DialogueHistoryReconcilerAdapter {
  return async (request) => {
    observer.begin();
    try {
      const result = await adapter(request);
      const resolvedModel = observer.finish();
      return { rawContent: result.rawContent, usage: result.usage, resolvedModel };
    } finally {
      observer.clear();
    }
  };
}

export function createDialogueHistoryRoutedAdapters(input: {
  apiKey: string;
  fetchImpl: typeof fetch;
}): {
  extractorAdapter: DialogueHistoryExtractorAdapter;
  reconcilerAdapter: DialogueHistoryReconcilerAdapter;
} {
  return boundary(() => {
    const config = projectRecord(input, CONFIG_FIELDS);
    if (
      typeof config.apiKey !== 'string' ||
      config.apiKey.trim().length === 0 ||
      typeof config.fetchImpl !== 'function'
    ) fail();

    const extractorObserver = createObserver(config.fetchImpl as typeof fetch);
    const reconcilerObserver = createObserver(config.fetchImpl as typeof fetch);
    const extractorTransport = createOpenRouterFetchTransport({
      fetchImpl: extractorObserver.fetch,
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
    const extract = createOpenRouterAdapter({
      transport: extractorTransport,
      apiKey: config.apiKey,
      model: LIFECYCLE_HISTORY_PRIMARY_MODEL,
      maxOutputTokens: LIFECYCLE_HISTORY_BACKFILL_MAX_OUTPUT_TOKENS_PER_CALL,
      reasoningEffort: 'low',
      responseContract: 'v2-layered',
      allowFallbacks: true,
      maxTokensParameter: 'max_tokens',
    });
    const extractorBase: MemoryV3ModelAdapter = async (request) => ({
      content: await extract(request),
      usage: null,
    });
    const reconcilerBase = createMemoryV3DialogueOpenRouterAdapter({
      apiKey: config.apiKey,
      fetchImpl: reconcilerObserver.fetch,
    });

    return Object.freeze({
      extractorAdapter: wrapExtractor(extractorObserver, extractorBase),
      reconcilerAdapter: wrapReconciler(reconcilerObserver, reconcilerBase),
    });
  });
}
