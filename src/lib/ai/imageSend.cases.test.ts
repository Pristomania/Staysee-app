import { sendAiMessage } from './client';
import type { ChatTransportDeps } from './clientTransport';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function depsReturning(response: Response, seen: { body?: Record<string, unknown> } = {}): ChatTransportDeps {
  return {
    getAccessToken: async () => 'token',
    getPublicConfig: () => ({ url: 'https://example.test', anonKey: 'anon' }),
    fetch: async (_input, init) => {
      seen.body = JSON.parse(String(init?.body));
      return response;
    },
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const images = [{ mime: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD' }];

async function main(): Promise<void> {
  // The pictures travel with the message, and nothing extra travels without them.
  {
    const seen: { body?: Record<string, unknown> } = {};
    await sendAiMessage({ message: 'привет', userId: 'u1', requestId: 'r1', images }, depsReturning(json({ content: 'Здравствуй!' }), seen));
    assert(Array.isArray(seen.body?.images) && (seen.body?.images as unknown[]).length === 1, 'images are sent');
  }
  {
    const seen: { body?: Record<string, unknown> } = {};
    await sendAiMessage({ message: 'привет', userId: 'u1', requestId: 'r2' }, depsReturning(json({ content: 'Здравствуй!' }), seen));
    assert(!('images' in (seen.body ?? {})), 'no images field without pictures');
  }

  // The text the server used (with the description lines) comes back, to be saved as the person's message.
  {
    const result = await sendAiMessage(
      { message: '', userId: 'u1', requestId: 'r3', images },
      depsReturning(json({ content: 'Вижу.', userText: '[Фото 1: Закат.]' })),
    );
    assert(result.status === 'success' && result.userText === '[Фото 1: Закат.]', 'userText is returned');
  }

  // Picture errors become a plain line, not a generic failure.
  for (const [error, fragment] of [
    ['images_disabled', 'пока'],
    ['image_unreadable', 'прочитать'],
    ['images_daily_limit', 'лимит'],
    ['images_invalid', 'не подошла'],
    ['images_unavailable', 'позже'],
  ] as const) {
    const result = await sendAiMessage({ message: 'x', userId: 'u1', requestId: `e-${error}`, images }, depsReturning(json({ error }, 422)));
    assert(result.status === 'images_error', `${error} is an images_error`);
    assert((result.userMessage ?? '').toLowerCase().includes(fragment), `${error}: ${result.userMessage}`);
  }

  // A proxy that refuses a body that is too big answers 413 with a page, not JSON.
  {
    const result = await sendAiMessage({ message: 'x', userId: 'u1', requestId: 'e-413', images }, depsReturning(new Response('<html>too big</html>', { status: 413 })));
    assert(result.status === 'images_error', '413 is an images_error');
  }

  console.log('imageSend.cases.test.ts passed');
}

main().catch((error) => {
  throw error;
});
