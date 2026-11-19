import { Webhook } from 'npm:standardwebhooks@1.1.1';
import { createAuthEmailHandler } from '../_shared/authEmailHandler.ts';

// Synthetic key, never a production credential. Real signing library, real HTTP boundary, no external services.
const wh = new Webhook(btoa('synthetic-test-key-not-for-production'));
const payload = JSON.stringify({ user: { id: '2073ab60-2556-48f3-bfa2-830f2434f482', email: 'test@example.invalid' }, email_data: { email_action_type: 'recovery', token_hash: 'synthetic-token' } });
function signedRequest(date = new Date(), body = payload): Request {
  const id = 'test-hook-event';
  return new Request('https://hook.invalid', { method: 'POST', body, headers: {
    'webhook-id': id, 'webhook-timestamp': String(Math.floor(date.getTime() / 1000)),
    'webhook-signature': wh.sign(id, date, payload),
  } });
}

Deno.test('signed hook accepts valid events; rejects tampered, old and missing signatures before lookup or send', async () => {
  let reads = 0;
  let sends = 0;
  const handler = createAuthEmailHandler({
    authUrl: 'https://project.supabase.co', siteUrl: 'https://staysee.ru',
    verify: (body, headers) => wh.verify(body, Object.fromEntries(headers)),
    lookupProfile: async () => { reads++; return null; },
    send: async () => { sends++; },
  });
  if ((await handler(signedRequest())).status !== 200 || reads !== 1 || sends !== 1) throw new Error('valid event rejected');
  for (const req of [signedRequest(new Date(Date.now() - 600_000)), signedRequest(new Date(), payload + ' '), new Request('https://hook.invalid', { method: 'POST', body: payload })]) {
    if ((await handler(req)).status !== 401) throw new Error('invalid signature accepted');
  }
  if (reads !== 1 || sends !== 1) throw new Error('unauthenticated side effect');
});
