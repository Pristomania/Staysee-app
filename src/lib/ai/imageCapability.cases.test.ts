import { askImagesCapability, imagesCapabilityCached, markImagesConsentGiven } from './imageCapability';
import type { ChatTransportDeps } from './clientTransport';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
function same(a: unknown, b: unknown, message: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function deps(answer: () => Promise<Response>, seen: Array<Record<string, unknown>> = []): ChatTransportDeps {
  return {
    getAccessToken: async () => 'token',
    getPublicConfig: () => ({ url: 'https://example.test', anonKey: 'anon' }),
    fetch: async (_input, init) => {
      seen.push(JSON.parse(String(init?.body)));
      return answer();
    },
  };
}

async function main(): Promise<void> {
  // The site asks the server once whether this person may attach pictures, and whether they already gave the
  // picture consent; the server decides (its own list, its own consent records).
  {
    const seen: Array<Record<string, unknown>> = [];
    const answer = await askImagesCapability('u1', deps(async () => json({ images: true, imagesConsent: false }), seen));
    same(answer, { allowed: true, consent: false }, 'allowed, consent still to give');
    assert(seen.length === 1 && seen[0].capabilities === 'images' && seen[0].message === '' && seen[0].userId === 'u1', 'the question is sent as agreed');
  }
  same(await askImagesCapability('u1', deps(async () => json({ images: true, imagesConsent: true }))), { allowed: true, consent: true }, 'allowed and consented');
  same(await askImagesCapability('u1', deps(async () => json({ images: false, imagesConsent: false }))), { allowed: false, consent: false }, 'not allowed');
  same(await askImagesCapability('u1', deps(async () => json({}))), { allowed: false, consent: true }, 'no answer field means not allowed');
  // A server from before the consent existed answers only { images: true }: it needs no consent either.
  same(await askImagesCapability('u1', deps(async () => json({ images: true }))), { allowed: true, consent: true }, 'an older server');

  // Anything that goes wrong means "not now" (null), never a crash and never a yes.
  assert((await askImagesCapability('u1', deps(async () => json({ error: 'message is required' }, 400)))) === null, 'an old server (400) is "not now"');
  assert((await askImagesCapability('u1', deps(async () => { throw new Error('network down'); }))) === null, 'a network error is "not now"');
  assert((await askImagesCapability('u1', deps(async () => new Response('<html>', { status: 502 })))) === null, 'a proxy error is "not now"');

  // An answer is remembered for the visit, per person; a failure is not remembered, so it is asked again.
  {
    let calls = 0;
    const counting = deps(async () => { calls += 1; return json({ images: true, imagesConsent: false }); });
    same(await imagesCapabilityCached('cache-user', counting), { allowed: true, consent: false }, 'first ask');
    same(await imagesCapabilityCached('cache-user', counting), { allowed: true, consent: false }, 'second ask');
    assert(calls === 1, 'asked the server once');
    assert((await imagesCapabilityCached('other-user', counting)).allowed === true && calls === 2, 'another person is asked separately');

    // After the person gives the consent, the remembered answer says so without asking again.
    markImagesConsentGiven('cache-user');
    same(await imagesCapabilityCached('cache-user', counting), { allowed: true, consent: true }, 'consent remembered');
    assert(calls === 2, 'no new question after the consent');
  }
  {
    let calls = 0;
    const flaky = deps(async () => {
      calls += 1;
      return calls === 1 ? json({ error: 'x' }, 500) : json({ images: true, imagesConsent: true });
    });
    same(await imagesCapabilityCached('flaky-user', flaky), { allowed: false, consent: false }, 'a failure shows no button');
    same(await imagesCapabilityCached('flaky-user', flaky), { allowed: true, consent: true }, 'a failure is asked again, not remembered');
    assert(calls === 2, 'two questions');
  }

  console.log('imageCapability.cases.test.ts passed');
}

main().catch((error) => {
  throw error;
});
