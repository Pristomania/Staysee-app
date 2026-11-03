/**
 * Run: npx tsx src/lib/authCallbackNotice.cases.test.ts
 * What the person is told on the sign-in screen after the link in the confirmation email (04.11.2026: the link
 * confirmed the address but did not let the person in, and they were left on the first screen with no word).
 */

import { AUTH_NOTICE_COPY, readAuthCallbackNotice } from './authCallbackNotice.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// The link of a confirmed sign-up brings the tokens in the fragment.
assert(readAuthCallbackNotice('#access_token=abc&expires_in=3600&refresh_token=def&token_type=bearer&type=signup', '') === 'confirmed', 'a confirmed sign-up');
// A link that is used up or old comes back with an error in the fragment (or in the query).
assert(readAuthCallbackNotice('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', '') === 'link_error', 'an expired link');
assert(readAuthCallbackNotice('', '?error=access_denied&error_code=otp_expired') === 'link_error', 'an error in the query');
assert(readAuthCallbackNotice('#error_code=otp_expired', '') === 'link_error', 'only the code');
// Everything else says nothing: a password-reset link has its own screen, a normal visit has no callback.
assert(readAuthCallbackNotice('#access_token=abc&type=recovery', '') === null, 'a reset link is not a confirmation');
assert(readAuthCallbackNotice('#access_token=abc&type=magiclink', '') === null, 'a magic link is not a confirmation');
assert(readAuthCallbackNotice('', '') === null && readAuthCallbackNotice('#/chat', '?utm=1') === null, 'a normal visit');

// The words: calm, they say what to do, nothing technical.
assert(/Почта подтверждена/.test(AUTH_NOTICE_COPY.confirmed) && /войдите/i.test(AUTH_NOTICE_COPY.confirmed), 'confirmed: says it and asks to sign in');
assert(/уже использована|устарела/.test(AUTH_NOTICE_COPY.link_error) && /войдите/i.test(AUTH_NOTICE_COPY.link_error), 'a dead link: says why and still points to signing in');
for (const text of Object.values(AUTH_NOTICE_COPY)) {
  assert(!/otp|token|error|supabase|http/i.test(text), 'nothing technical in the words');
}

console.log('All authCallbackNotice cases passed.');
