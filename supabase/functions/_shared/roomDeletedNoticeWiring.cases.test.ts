/**
 * Run: npx tsx supabase/functions/_shared/roomDeletedNoticeWiring.cases.test.ts
 * The message for a deleted room is wired on every road that finds the room deleted: the sign-in itself, and the
 * profile load that follows any sign-in or restored session. Then the person is brought to the sign-in screen, which
 * shows it. Read from the sources, because the screens need a browser.
 */

import { readFileSync } from 'node:fs';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const auth = read('src/context/AuthContext.tsx');
const app = read('src/App.tsx');
const login = read('src/components/screens/LoginScreen.tsx');

// Both places that find the room deleted note the message with the day, before they sign the person out.
const noted = [...auth.matchAll(/rememberRoomDeletedNotice\(([^)]*)\)/g)];
assert(noted.length === 2, `the message is noted in two places (the sign-in and the profile load), found ${noted.length}`);
assert(noted.every((match) => /room_purge_after/.test(match[1])), 'each notes the day the address opens again');
const profileLoad = auth.slice(auth.indexOf('async function loadProfileSafe'), auth.indexOf('function subscribeToAuthChanges'));
assert(/rememberRoomDeletedNotice[\s\S]{0,200}safeLocalSignOut\(\)/.test(profileLoad), 'the profile load notes it before signing out');
const signIn = auth.slice(auth.indexOf('async function signIn('), auth.indexOf('async function signUp('));
assert(/rememberRoomDeletedNotice[\s\S]{0,200}supabase\.auth\.signOut\(\)/.test(signIn), 'the sign-in notes it before signing out');

// Nobody is signed in and the message waits: the sign-in screen, not the first screen.
assert(/hasRoomDeletedNotice\(\)/.test(app), 'App knows about the waiting message');
assert(/currentScreen === 'welcome' && \(hasAuthCallbackNotice\(\) \|\| hasRoomDeletedNotice\(\)\)/.test(app), 'it takes a signed-out person from the first screen to the sign-in screen');

// The sign-in screen shows it as its error and then forgets it, both when it was built after the detour and when the
// error came straight back from the sign-in.
assert(/peekRoomDeletedNotice\(\)/.test(login) && /roomDeletedLoginText\(/.test(login), 'the sign-in screen shows the noted message with the day');
assert(/forgetRoomDeletedNotice\(\)/.test(login), 'and forgets it');
assert(/useEffect\(\(\) => \{[\s\S]{0,120}forgetRoomDeletedNotice\(\)/.test(login), 'once the screen is up, so it is shown once');

console.log('All roomDeletedNoticeWiring cases passed.');
