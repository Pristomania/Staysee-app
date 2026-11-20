/**
 * The call to admin-api (src/lib/admin/adminApi.ts), with a fake network.
 * Run: npx tsx src/lib/admin/adminApi.cases.test.ts
 */

import { callAdmin, type AdminApiDeps } from './adminApi.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function same(actual: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

interface Seen {
  url: string;
  init: RequestInit;
}

function deps(options: { token?: string | null; status?: number; body?: unknown; fail?: boolean; notJson?: boolean }): { deps: AdminApiDeps; seen: Seen[] } {
  const seen: Seen[] = [];
  const result: AdminApiDeps = {
    getAccessToken: async () => (options.token === undefined ? 'token-123' : options.token),
    getPublicConfig: () => ({ url: 'https://example.test/supabase', anonKey: 'anon-key' }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      if (options.fail) throw new TypeError('Failed to fetch');
      const status = options.status ?? 200;
      const payload = options.notJson ? '<html>gateway error</html>' : JSON.stringify(options.body ?? { ok: true, data: null });
      return new Response(payload, { status, headers: { 'Content-Type': options.notJson ? 'text/html' : 'application/json' } });
    }) as typeof fetch,
  };
  return { deps: result, seen };
}

// ── what is sent ────────────────────────────────────────────────────────────────────────────────────────
{
  const { deps: d, seen } = deps({ body: { ok: true, data: { people: { total: 12 } } } });
  const result = await callAdmin<{ people: { total: number } }>(d, 'overview');
  same(result, { ok: true, data: { people: { total: 12 } } }, 'the data is handed back');
  assert(seen.length === 1, 'one request');
  assert(seen[0]!.url === 'https://example.test/supabase/functions/v1/admin-api', 'the address of the function');
  assert(seen[0]!.init.method === 'POST', 'POST');
  const headers = seen[0]!.init.headers as Record<string, string>;
  assert(headers.Authorization === 'Bearer token-123', 'the login token');
  assert(headers.Apikey === 'anon-key', 'the public key');
  assert(headers['Content-Type'] === 'application/json', 'json');
  same(JSON.parse(String(seen[0]!.init.body)), { action: 'overview', params: {} }, 'the body: action and empty params');
  console.log('✓ the request: address, method, token, body');
}
{
  const { deps: d, seen } = deps({});
  await callAdmin(d, 'people', { search: 'anna', limit: 50 });
  same(JSON.parse(String(seen[0]!.init.body)), { action: 'people', params: { search: 'anna', limit: 50 } }, 'params are sent');
  console.log('✓ params are sent as given');
}

// ── what comes back ─────────────────────────────────────────────────────────────────────────────────────
{
  const refused = await callAdmin(deps({ status: 403, body: { error: 'not_admin' } }).deps, 'overview');
  same(refused, { ok: false, status: 403, reason: 'not_admin' }, 'a refusal keeps its reason');
  const stale = await callAdmin(deps({ status: 401, body: { error: 'password_stale' } }).deps, 'overview');
  same(stale, { ok: false, status: 401, reason: 'password_stale' }, 'a stale password');
  const bad = await callAdmin(deps({ status: 400, body: { error: 'unknown_label' } }).deps, 'set_label', { user_id: 'x', label_key: 'y' });
  same(bad, { ok: false, status: 400, reason: 'unknown_label' }, 'a refusal of the database');
  console.log('✓ refusals keep status and reason');
}
{
  const gateway = await callAdmin(deps({ status: 502, notJson: true }).deps, 'overview');
  same(gateway, { ok: false, status: 502, reason: 'unknown_error' }, 'an answer that is not json');
  const odd = await callAdmin(deps({ status: 200, body: { nothing: 1 } }).deps, 'overview');
  same(odd, { ok: false, status: 200, reason: 'unknown_error' }, 'a 200 without ok:true is not trusted');
  console.log('✓ an answer that is not ours is an unknown error, not data');
}

// ── no session, no network ──────────────────────────────────────────────────────────────────────────────
{
  const { deps: d, seen } = deps({ token: null });
  same(await callAdmin(d, 'overview'), { ok: false, status: 401, reason: 'no_session' }, 'no token');
  assert(seen.length === 0, 'nothing is sent without a session');
  same(await callAdmin(deps({ token: '   ' }).deps, 'overview'), { ok: false, status: 401, reason: 'no_session' }, 'a blank token');
  same(await callAdmin(deps({ fail: true }).deps, 'overview'), { ok: false, status: 0, reason: 'network' }, 'the network fails');
  const brokenConfig: AdminApiDeps = {
    getAccessToken: async () => 'token-123',
    getPublicConfig: () => {
      throw new Error('Missing VITE_SUPABASE_URL');
    },
    fetch: (async () => new Response('{}')) as typeof fetch,
  };
  same(await callAdmin(brokenConfig, 'overview'), { ok: false, status: 0, reason: 'network' }, 'a missing config is not a crash');
  console.log('✓ no session sends nothing; a network failure or missing config is reported, not thrown');
}

console.log('All adminApi cases passed.');
