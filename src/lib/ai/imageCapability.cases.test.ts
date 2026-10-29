import { askImagesAllowed, imagesAllowedCached } from './imageCapability';
import type { ChatTransportDeps } from './clientTransport';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
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
  // The site asks the server once whether this person may attach pictures; the server decides (its own list).
  {
    const seen: Array<Record<string, unknown>> = [];
    const allowed = await askImagesAllowed('u1', deps(async () => json({ images: true }), seen));
    assert(allowed === true, 'the server says yes');
    assert(seen.length === 1 && seen[0].capabilities === 'images' && seen[0].message === '' && seen[0].userId === 'u1', 'the question is sent as agreed');
  }
  assert((await askImagesAllowed('u1', deps(async () => json({ images: false })))) === false, 'the server says no');
  assert((await askImagesAllowed('u1', deps(async () => json({})))) === false, 'no answer field means no');

  // Anything that goes wrong means "not now" (null), never a crash and never a yes.
  assert((await askImagesAllowed('u1', deps(async () => json({ error: 'message is required' }, 400)))) === null, 'an old server (400) is "not now"');
  assert((await askImagesAllowed('u1', deps(async () => { throw new Error('network down'); }))) === null, 'a network error is "not now"');
  assert((await askImagesAllowed('u1', deps(async () => new Response('<html>', { status: 502 })))) === null, 'a proxy error is "not now"');

  // An answer is remembered for the visit, per person; a failure is not remembered, so it is asked again.
  {
    let calls = 0;
    const counting = deps(async () => { calls += 1; return json({ images: true }); });
    assert((await imagesAllowedCached('cache-user', counting)) === true, 'first ask');
    assert((await imagesAllowedCached('cache-user', counting)) === true, 'second ask');
    assert(calls === 1, 'asked the server once');
    assert((await imagesAllowedCached('other-user', counting)) === true && calls === 2, 'another person is asked separately');
  }
  {
    let calls = 0;
    const flaky = deps(async () => {
      calls += 1;
      return calls === 1 ? json({ error: 'x' }, 500) : json({ images: true });
    });
    assert((await imagesAllowedCached('flaky-user', flaky)) === false, 'a failure shows no button');
    assert((await imagesAllowedCached('flaky-user', flaky)) === true && calls === 2, 'a failure is asked again, not remembered');
  }

  console.log('imageCapability.cases.test.ts passed');
}

main().catch((error) => {
  throw error;
});
