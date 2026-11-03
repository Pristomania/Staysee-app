/**
 * Run: npx tsx supabase/functions/_shared/appUpdateWiring.cases.test.ts
 * The pieces that keep an open page from running an old version: the server never lets the browser keep the page
 * itself without asking, the app watches for a new version when the person comes back, and a file that has gone
 * after an update does not leave a blank screen. Read from the sources, because the browser and nginx are not here.
 */

import { readFileSync } from 'node:fs';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8').replace(/\r/g, '');

// ── nginx: the page is always asked for again, the build files stay cached for good ─────────────────────
for (const file of ['deploy/nginx/staysee.ru.conf', 'deploy/nginx/staysee.ru.no-http2.conf']) {
  const conf = read(file);
  const block = /location = \/index\.html \{([\s\S]*?)\n    \}/.exec(conf);
  assert(block, `${file}: the page has its own location`);
  assert(/add_header Cache-Control "no-cache" always;/.test(block[1]), `${file}: the page is never kept without asking`);
  // add_header in a location replaces the ones set for the whole server, so they are written again here.
  for (const header of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy']) {
    assert(new RegExp(`add_header ${header} `).test(block[1]), `${file}: ${header} is still sent with the page`);
  }
  assert(/location \/assets\/ \{[\s\S]*?immutable/.test(conf), `${file}: the build files stay cached for good (their names change with every build)`);
}

// ── the app ─────────────────────────────────────────────────────────────────────────────────────────────
const main = read('src/main.tsx');
assert(/<UpdateNotice \/>/.test(main), 'the notice (and the watcher in it) is on every screen');

const notice = read('src/components/UpdateNotice.tsx');
assert(/startAppUpdateWatcher\(/.test(notice) && /window\.location\.reload\(\)/.test(notice), 'the notice starts the watcher and its button reloads');

const watcher = read('src/lib/appUpdateWatcher.ts');
assert(/visibilitychange/.test(watcher), 'it checks when the person comes back to the page');
assert(/cache: 'no-store'/.test(watcher), 'it asks the server for the real current page, not a kept one');
assert(/vite:preloadError/.test(watcher), 'a build file that went after an update is met by a reload');
assert(/dynamically imported module|Importing a module script failed/.test(watcher), 'also when the browser reports it as a plain failed import');
assert(/sessionStorage/.test(watcher), 'a reload is never repeated in a loop');

const chat = read('src/components/screens/ChatScreen.tsx');
assert(/setAppBusy\('chat', sending \|\| shouldStopVoiceDictation\(voice\.snapshot\.phase\)\)/.test(chat), 'the chat tells the app when a message is on its way or a voice is recorded');

console.log('All appUpdateWiring cases passed.');
