import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getTechnicalUserAccessToken } from './prod-test-session.mjs';

const URL_BASE = 'https://project.example.test';
const SERVICE_KEY = 'service-key-value-for-tests';
const USER_ID = '5349a89a-4cc5-4338-b841-8a5723c95d8f';

function fakeFetch(overrides = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (overrides[init.method]) return overrides[init.method](url, init);
    if (init.method === 'GET') {
      return json(200, { id: USER_ID, email: 'tech@staysee.invalid', user_metadata: { technical_test_user: true } });
    }
    if (init.method === 'PUT') return json(200, { id: USER_ID });
    return json(200, { access_token: 'user-jwt-for-tests', token_type: 'bearer' });
  };
  return { impl, calls };
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

describe('technical test user session', () => {
  it('gives the technical user a fresh password, signs in with it, and returns the user token', async () => {
    const { impl, calls } = fakeFetch();
    const token = await getTechnicalUserAccessToken({ url: URL_BASE, serviceKey: SERVICE_KEY, testUserId: USER_ID, fetchImpl: impl });
    assert.equal(token, 'user-jwt-for-tests');
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url.replace(URL_BASE, '')}`), [
      `GET /auth/v1/admin/users/${USER_ID}`,
      `PUT /auth/v1/admin/users/${USER_ID}`,
      'POST /auth/v1/token?grant_type=password',
    ]);
    const password = calls[1].body.password;
    assert.ok(typeof password === 'string' && password.length >= 32, 'the password is long and random');
    assert.deepEqual(calls[2].body, { email: 'tech@staysee.invalid', password }, 'signs in with exactly the password it just set');
  });

  it('uses a different password every time', async () => {
    const first = fakeFetch();
    const second = fakeFetch();
    await getTechnicalUserAccessToken({ url: URL_BASE, serviceKey: SERVICE_KEY, testUserId: USER_ID, fetchImpl: first.impl });
    await getTechnicalUserAccessToken({ url: URL_BASE, serviceKey: SERVICE_KEY, testUserId: USER_ID, fetchImpl: second.impl });
    assert.notEqual(first.calls[1].body.password, second.calls[1].body.password);
  });

  it('refuses a user that is not marked as a technical test user', async () => {
    const { impl, calls } = fakeFetch({ GET: () => json(200, { id: USER_ID, email: 'real@person.test', user_metadata: {} }) });
    await assert.rejects(
      getTechnicalUserAccessToken({ url: URL_BASE, serviceKey: SERVICE_KEY, testUserId: USER_ID, fetchImpl: impl }),
      /not marked as a technical test user/,
    );
    assert.equal(calls.some((call) => call.init.method === 'PUT'), false, 'never changes a real person\'s password');
  });

  it('accepts the technical user only when its marker is present', async () => {
    const { impl } = fakeFetch({ GET: () => json(200, { id: USER_ID, email: 'tech@staysee.invalid', user_metadata: { technical_test_user: true } }) });
    assert.equal(
      await getTechnicalUserAccessToken({ url: URL_BASE, serviceKey: SERVICE_KEY, testUserId: USER_ID, fetchImpl: impl }),
      'user-jwt-for-tests',
    );
  });

  it('fails with a clear message that never contains the password or the keys', async () => {
    for (const failing of ['GET', 'PUT', 'POST']) {
      const { impl, calls } = fakeFetch({ [failing]: () => json(500, { message: 'boom' }) });
      await assert.rejects(
        getTechnicalUserAccessToken({ url: URL_BASE, serviceKey: SERVICE_KEY, testUserId: USER_ID, fetchImpl: impl }),
        (error) => {
          const password = calls.find((call) => call.init.method === 'PUT')?.body.password;
          return /HTTP 500/.test(error.message) &&
            !error.message.includes(SERVICE_KEY) && !(password && error.message.includes(password));
        },
      );
    }
  });

  it('fails when sign-in returns no token', async () => {
    const { impl } = fakeFetch({ POST: () => json(200, {}) });
    await assert.rejects(
      getTechnicalUserAccessToken({ url: URL_BASE, serviceKey: SERVICE_KEY, testUserId: USER_ID, fetchImpl: impl }),
      /no access token/,
    );
  });
});
