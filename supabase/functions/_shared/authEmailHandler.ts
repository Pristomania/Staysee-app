import { buildAuthEmails, type AuthEmailEvent, type AuthMail, type DeletionProfile } from './authEmail.ts';
export interface AuthEmailDependencies {
  verify: (payload: string, headers: Headers) => unknown;
  lookupProfile: (userId: string, signal: AbortSignal) => Promise<DeletionProfile | null>;
  send: (mail: AuthMail, signal: AbortSignal) => Promise<void>;
  authUrl: string;
  siteUrl: string;
}
export function createAuthEmailHandler(deps: AuthEmailDependencies, timeoutMs = 4500): (request: Request) => Promise<Response> {
  const response = (status: number) => Response.json(status === 200 ? {} : { error: { http_code: status, message: 'Email processing failed' } }, { status });
  const handle = async (request: Request, signal: AbortSignal): Promise<Response> => {
    if (request.method !== 'POST') return response(405);
    // Read with a bound even when the caller omits/lies about Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return response(400);
    signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}); }, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) { await reader.cancel(); return response(413); }
        chunks.push(value);
      }
    } catch { return response(400); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (signal.aborted) return response(503);
    let raw: unknown;
    try { raw = deps.verify(new TextDecoder().decode(bytes), request.headers); }
    catch { return response(401); }
    const event = raw as AuthEmailEvent | null;
    if (!event?.user || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(event.user.id ?? '')
      || typeof event.user.email !== 'string' || typeof event.email_data?.email_action_type !== 'string') return response(400);
    try {
      // Query failures must throw, not be collapsed to a missing/active profile.
      const profile = await deps.lookupProfile(event.user.id, signal);
      signal.throwIfAborted();
      const mails = buildAuthEmails(event, profile, deps);
      // Secure email change needs both addresses. Do not spend two serial SMTP round trips in the 5s hook budget.
      await Promise.all(mails.map(mail => deps.send(mail, signal)));
      signal.throwIfAborted();
      return response(200);
    } catch {
      // No SMTP errors, signed payloads, recipient addresses or action tokens in logs/responses.
      return response(503);
    }
  };
  return async (request) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Response>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(response(503)); }, timeoutMs);
    });
    try { return await Promise.race([handle(request, controller.signal), timeout]); }
    finally {
      clearTimeout(timer);
      // Promise.all can reject while the sibling SMTP is still active. Cancel it before returning an error.
      controller.abort();
    }
  };
}
