/**
 * Signs in as the dedicated technical test user and returns a normal user access
 * token. staysee-chat accepts only a user's own token (a service-role key is
 * rejected with 401 since the 22.09.2026 security hardening), so a production
 * smoke test has to be a real signed-in user.
 *
 * Each call gives the technical user a fresh random password through the admin
 * API and signs in with it; the password lives only in this function. It will
 * NEVER do this to a user that is not marked user_metadata.technical_test_user,
 * so a wrong STAYSEE_TEST_USER_ID can never lock a real person out.
 */
import { randomBytes } from 'node:crypto';

async function call(fetchImpl, label, url, init) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  if (!response.ok) {
    // Only the step name and status: the response body and the request can hold secrets.
    throw new Error(`${label} failed: HTTP ${response.status}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} failed: unreadable response`);
  }
}

export async function getTechnicalUserAccessToken({ url, serviceKey, testUserId, fetchImpl = fetch }) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  const adminUser = `${url}/auth/v1/admin/users/${testUserId}`;

  const user = await call(fetchImpl, 'read technical user', adminUser, { method: 'GET', headers });
  if (user?.user_metadata?.technical_test_user !== true) {
    throw new Error(
      `user ${testUserId} is not marked as a technical test user (user_metadata.technical_test_user); refusing to touch it`,
    );
  }
  if (typeof user.email !== 'string' || user.email === '') {
    throw new Error('technical test user has no email to sign in with');
  }

  const password = randomBytes(24).toString('hex');
  await call(fetchImpl, 'set technical user password', adminUser, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ password }),
  });

  const session = await call(fetchImpl, 'sign in as technical user', `${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: user.email, password }),
  });
  if (typeof session.access_token !== 'string' || session.access_token === '') {
    throw new Error('sign in as technical user returned no access token');
  }
  return session.access_token;
}
