/**
 * The cost of calls made OUTSIDE the app (checks, comparisons, one-off runs from a script) goes into the same log the app writes
 * (ai_usage_logs), so the admin panel counts it. Such a row has no person: user_id is empty, cost_category is 'technical', and
 * call_kind is `offapp:<what the run was for>`.
 *
 * Use: wrap the fetch that reaches the model provider, once, where the script is started:
 *
 *     const fetchWithCosts = wrapForOffAppUsage(globalThis.fetch.bind(globalThis), 'memory-benchmark');
 *
 * Every paid call made through it (a chat answer, or embeddings) is written down (model, tokens, cost, how it ended). The cost is the one the provider
 * reports (OpenRouter sends usage.cost); when there is none (Cloud.ru and others) it is counted from the table of prices the app uses.
 *
 * It does not let a run start that cannot write its costs (no address or key of the database): losing the cost silently is the thing
 * this file exists to prevent. If a single write fails after retries, the row is printed in full on stderr so it can be entered by hand,
 * and the run goes on (the money is already spent).
 *
 * Nothing here prints or stores the key. The database is written with the service key through the REST address, like the other scripts.
 */

export const OFF_APP_KIND_PREFIX = 'offapp:';

/** `offapp:<slug>`; the slug is what the run is for, in latin letters, digits, - and _ (so the log stays tidy). */
export function offAppKind(what) {
  const slug = String(what ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!slug) throw new Error('off-app usage log: say what the run is for, in latin letters (for example "memory-benchmark")');
  return `${OFF_APP_KIND_PREFIX}${slug}`;
}

function whole(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** The row for one call made outside the app. `cost` is already worked out; anything unknown stays empty or zero, never invented. */
export function buildOffAppUsageRow({ what, model, usage, cost, finishReason, latencyMs, errorCode }) {
  const prompt = whole(usage?.prompt_tokens);
  const completion = whole(usage?.completion_tokens);
  return {
    user_id: null,
    model: typeof model === 'string' && model.trim() ? model.trim() : 'unknown',
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: whole(usage?.total_tokens) || prompt + completion,
    cost: Number.isFinite(cost) && cost >= 0 ? cost : 0,
    cost_category: 'technical',
    call_kind: offAppKind(what),
    finish_reason: typeof finishReason === 'string' ? finishReason : null,
    latency_ms: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
    error_code: typeof errorCode === 'string' ? errorCode : null,
  };
}

/** The table of prices the app uses, loaded when first needed (it is a TypeScript file; an old Node cannot read it, then the cost stays 0 and is marked). */
async function defaultLoadPricing() {
  return import('../../supabase/functions/_shared/openRouterPricing.ts');
}

function readRequest(init) {
  try {
    const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    return { model: typeof parsed?.model === 'string' ? parsed.model : null, stream: parsed?.stream === true };
  } catch {
    return { model: null, stream: false };
  }
}

function addressOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return typeof input?.url === 'string' ? input.url : '';
}

/**
 * The paid calls: a chat answer, the vectors for the memory search (embeddings), and the reranker that sorts the found lines (rerank, score).
 * Anything else (the list of models, say) is free.
 */
function isPaidCall(input) {
  return /\/(?:chat\/completions|embeddings|rerank|score)(?:\?|$)/.test(addressOf(input));
}

/** A reranker (and some hosts) report only total_tokens: everything it read is input. */
function usageWithInput(usage) {
  if (whole(usage.prompt_tokens) === 0 && whole(usage.completion_tokens) === 0 && whole(usage.total_tokens) > 0) {
    return { ...usage, prompt_tokens: whole(usage.total_tokens) };
  }
  return usage;
}

export function createOffAppUsageRecorder({
  supabaseUrl,
  serviceRoleKey,
  what,
  fetchImpl = globalThis.fetch.bind(globalThis),
  warn = (message) => process.stderr.write(`${message}\n`),
  loadPricing = defaultLoadPricing,
  retries = 2,
}) {
  const missing = [];
  if (!supabaseUrl) missing.push('VITE_SUPABASE_URL');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    throw new Error(`Расходы этого запуска некуда записать: не заданы ${missing.join(' и ')}. Запуск остановлен, чтобы расходы не терялись.`);
  }
  offAppKind(what); // refuses a run that does not say what it is for

  const endpoint = `${String(supabaseUrl).replace(/\/+$/, '')}/rest/v1/ai_usage_logs`;
  const written = [];
  const failures = [];

  async function record(row) {
    let last = 'unknown';
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(row),
        });
        if (response.ok) {
          written.push(row);
          return true;
        }
        last = `HTTP ${response.status}`;
      } catch {
        last = 'network';
      }
    }
    failures.push(row);
    warn(`[off-app-usage] НЕ ЗАПИСАНО (${last}). Внеси строку в ai_usage_logs вручную: ${JSON.stringify(row)}`);
    return false;
  }

  async function costOf(model, usage) {
    if (typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) return { cost: Math.round(usage.cost * 1e8) / 1e8, unknown: false };
    try {
      const pricing = await loadPricing();
      return { cost: pricing.resolveRequestCost(model, usage, whole(usage.prompt_tokens), whole(usage.completion_tokens)), unknown: false };
    } catch {
      warn('[off-app-usage] цену этого вызова посчитать не удалось (таблица тарифов не загрузилась), записан 0 с пометкой cost_unknown');
      return { cost: 0, unknown: true };
    }
  }

  function wrapFetch(inner) {
    return async function fetchWithOffAppUsage(input, init) {
      if (!isPaidCall(input)) return inner(input, init);

      const requested = readRequest(init);
      const started = Date.now();
      let response;
      try {
        response = await inner(input, init);
      } catch (error) {
        await record(buildOffAppUsageRow({ what, model: requested.model, errorCode: 'request_failed', latencyMs: Date.now() - started }));
        throw error;
      }
      const latencyMs = Date.now() - started;

      if (requested.stream) {
        warn('[off-app-usage] ответ-поток: цену посчитать нельзя, записан вызов с нулём и пометкой usage_not_counted_stream');
        await record(buildOffAppUsageRow({ what, model: requested.model, errorCode: 'usage_not_counted_stream', latencyMs }));
        return response;
      }

      let body = null;
      try {
        body = JSON.parse(await response.clone().text());
      } catch {
        body = null;
      }
      const model = body?.model ?? requested.model;
      const usage = body?.usage && typeof body.usage === 'object' ? usageWithInput(body.usage) : null;
      if (!usage) {
        if (response.ok) warn('[off-app-usage] в ответе нет usage: расход этого вызова неизвестен, записан 0 с пометкой usage_missing');
        await record(buildOffAppUsageRow({ what, model, errorCode: response.ok ? 'usage_missing' : `http_${response.status}`, latencyMs }));
        return response;
      }

      const { cost, unknown } = await costOf(requested.model ?? model, usage);
      await record(
        buildOffAppUsageRow({
          what,
          model,
          usage,
          cost,
          finishReason: body?.choices?.[0]?.finish_reason ?? null,
          latencyMs,
          errorCode: !response.ok ? `http_${response.status}` : unknown ? 'cost_unknown' : null,
        }),
      );
      return response;
    };
  }

  return { record, wrapFetch, written, failures };
}

/**
 * The usual way in: the address and the service key come from the environment, as in the other scripts.
 *
 * The check of the address and the key happens at the FIRST chat call, before it is sent: a dry run (which makes no call) starts without
 * them, and a paid call that could not be written down never leaves the machine, so nothing is spent unrecorded. A run that does not say
 * what it is for is refused at once.
 */
export function wrapForOffAppUsage(fetchImpl, what, { env = process.env, ...rest } = {}) {
  offAppKind(what);
  let wrapped = null;
  return async function fetchGuardedByOffAppUsage(input, init) {
    if (!isPaidCall(input)) return fetchImpl(input, init);
    wrapped ??= createOffAppUsageRecorder({
      supabaseUrl: env.VITE_SUPABASE_URL ?? env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      what,
      ...rest,
    }).wrapFetch(fetchImpl);
    return wrapped(input, init);
  };
}
