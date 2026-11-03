/**
 * Run: npx tsx supabase/functions/_shared/authCallbackNoticeWiring.cases.test.ts
 * The notice after the confirmation link is wired end to end: noted when the page opens with the link, forgotten when
 * the person is let in, shown on the sign-in screen, and the person is taken there when nobody is signed in.
 * Read from the sources, because the screens need a browser.
 */

import { readFileSync } from 'node:fs';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const auth = read('src/context/AuthContext.tsx');
const app = read('src/App.tsx');
const login = read('src/components/screens/LoginScreen.tsx');

// Noted before anything can clear the address bar, forgotten the moment the person is signed in.
const first = auth.indexOf('rememberAuthCallbackNotice(');
assert(first >= 0, 'AuthContext notes the notice when the page opens with the link');
assert(first < auth.indexOf('getAuthCallbackTypeFromUrl()'), 'it is noted before the callback type is handled');
assert(/event === 'SIGNED_IN'[\s\S]{0,400}forgetAuthCallbackNotice\(\)/.test(auth), 'a person who is let in is not shown the notice later');

// The first screen is not where this person belongs: nobody signed in and a notice waiting means the sign-in screen.
assert(/hasAuthCallbackNotice\(\)/.test(app) && /replaceNavigation\('login'\)/.test(app), 'App takes a signed-out person with a notice to the sign-in screen');
assert(/!user[\s\S]{0,300}hasAuthCallbackNotice\(\)/.test(app), 'only when nobody is signed in');

// The sign-in screen shows it once.
assert(/peekAuthCallbackNotice\(\)/.test(login) && /AUTH_NOTICE_COPY/.test(login), 'the sign-in screen shows the notice');
// StrictMode builds a screen twice, so the notice is read without being used up and forgotten after the screen is up.
assert(/useEffect\(\(\) => \{\s*forgetAuthCallbackNotice\(\);\s*\}, \[\]\)/.test(login), 'and forgets it once the screen is up, so it is shown once');

console.log('All authCallbackNoticeWiring cases passed.');
