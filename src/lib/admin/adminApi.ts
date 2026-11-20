/**
 * The call to the edge function admin-api (supabase/functions/admin-api). Made from its dependencies so it can be tested without a
 * network and without the real client (the real ones are in adminApiClient.ts).
 *
 * Answers: { ok: true, data } only when the function said ok:true. Everything else is { ok: false, status, reason }:
 * a refusal keeps the reason the function gave (not_admin, password_stale, bad_request, unknown_label ...); no session is
 * 401 no_session; a failed network (or a missing public config) is status 0, reason network; an answer that is not ours is
 * unknown_error. Nothing is thrown.
 */

export interface AdminApiDeps {
  fetch: typeof fetch;
  getAccessToken(): Promise<string | null>;
  getPublicConfig(): { url: string; anonKey: string };
}

export type AdminCallResult<T> = { ok: true; data: T } | { ok: false; status: number; reason: string };

export async function callAdmin<T>(
  deps: AdminApiDeps,
  action: string,
  params: Record<string, unknown> = {},
): Promise<AdminCallResult<T>> {
  const token = (await deps.getAccessToken())?.trim() ?? '';
  if (!token) return { ok: false, status: 401, reason: 'no_session' };

  let response: Response;
  try {
    const { url, anonKey } = deps.getPublicConfig();
    response = await deps.fetch(`${url}/functions/v1/admin-api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Apikey: anonKey,
      },
      body: JSON.stringify({ action, params }),
    });
  } catch {
    return { ok: false, status: 0, reason: 'network' };
  }

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  const body = typeof json === 'object' && json !== null ? (json as { ok?: unknown; data?: unknown; error?: unknown }) : {};

  if (response.ok && body.ok === true) return { ok: true, data: body.data as T };
  return { ok: false, status: response.status, reason: typeof body.error === 'string' ? body.error : 'unknown_error' };
}
