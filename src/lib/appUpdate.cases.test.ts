/**
 * Run: npx tsx src/lib/appUpdate.cases.test.ts
 * A page that stays open (or a phone that comes back to the browser) runs the version it loaded, however many times the
 * site has been updated since. The app asks the server which version is current; when it differs, it reloads itself if
 * that costs the person nothing, and otherwise says so quietly. These are the rules of that decision.
 */

import {
  AUTO_RELOAD_AFTER_HIDDEN_MS,
  UPDATE_NOTICE_COPY,
  decideUpdateAction,
  entryFromHtml,
  isNewVersion,
} from './appUpdate.ts';
import { isAppBusy, setAppBusy } from './appBusy.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── which version a page is: the name of its main script ────────────────────────────────────────────────
const page = (script: string) => `<!doctype html><html><head><script type="module" crossorigin src="${script}"></script><link rel="stylesheet" href="/assets/index-AbC123.css"></head><body><div id="root"></div></body></html>`;
assert(entryFromHtml(page('/assets/index-T646IS8G.js')) === '/assets/index-T646IS8G.js', 'the main script of a page');
assert(entryFromHtml('<script type="module" src="/assets/vendor-Zz9.js"></script>') === null, 'another script is not the entry');
assert(entryFromHtml('<html>maintenance</html>') === null && entryFromHtml('') === null, 'a page without it');
assert(entryFromHtml(page('/assets/index-a_b-C.js')) === '/assets/index-a_b-C.js', 'names may contain _ and -');

assert(isNewVersion('/assets/index-A.js', '/assets/index-B.js') === true, 'different scripts: a new version');
assert(isNewVersion('/assets/index-A.js', '/assets/index-A.js') === false, 'the same script: nothing new');
assert(isNewVersion(null, '/assets/index-B.js') === false && isNewVersion('/assets/index-A.js', null) === false, 'when either is unknown, nothing is claimed');

// ── what to do about it ─────────────────────────────────────────────────────────────────────────────────
const base = { newVersion: true, hiddenForMs: AUTO_RELOAD_AFTER_HIDDEN_MS + 1000, busy: false, hasUnsentText: false, alreadyReloadedFor: null as string | null, latest: '/assets/index-B.js' };
assert(decideUpdateAction({ ...base, newVersion: false }) === 'none', 'nothing new: nothing to do');
assert(decideUpdateAction(base) === 'reload', 'new, the person was away for a while and has nothing unsaved: reload');
assert(decideUpdateAction({ ...base, hiddenForMs: AUTO_RELOAD_AFTER_HIDDEN_MS - 1000 }) === 'notice', 'away only a moment: do not pull the page from under them');
assert(decideUpdateAction({ ...base, hiddenForMs: null }) === 'notice', 'looking at the page the whole time: a quiet notice, not a reload');
assert(decideUpdateAction({ ...base, busy: true }) === 'notice', 'a message is being sent or a voice recorded: a notice');
assert(decideUpdateAction({ ...base, hasUnsentText: true }) === 'notice', 'something typed and not sent: a notice');
assert(decideUpdateAction({ ...base, alreadyReloadedFor: '/assets/index-B.js' }) === 'notice', 'already reloaded for this version and still old: a notice, never a loop');
assert(decideUpdateAction({ ...base, alreadyReloadedFor: '/assets/index-OLD.js' }) === 'reload', 'a reload for an earlier version does not stop this one');

// ── busy marks: set by the screens that must not be interrupted ─────────────────────────────────────────
assert(!isAppBusy(), 'idle at the start');
setAppBusy('chat', true);
setAppBusy('upload', true);
assert(isAppBusy(), 'busy while any mark is set');
setAppBusy('chat', false);
assert(isAppBusy(), 'one mark left');
setAppBusy('upload', false);
assert(!isAppBusy(), 'idle again');

// ── the words ───────────────────────────────────────────────────────────────────────────────────────────
assert(/новая версия/i.test(UPDATE_NOTICE_COPY.text) && UPDATE_NOTICE_COPY.button === 'Обновить', 'the notice says so and offers the button');
assert(!/error|ошибк|сбой|fetch|http/i.test(UPDATE_NOTICE_COPY.text), 'calm, nothing technical');

console.log('All appUpdate cases passed.');
