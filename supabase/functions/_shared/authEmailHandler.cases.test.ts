import assert from 'node:assert/strict';
import { createAuthEmailHandler, type AuthEmailDependencies } from './authEmailHandler.ts';
const event = { user: { id: '2073ab60-2556-48f3-bfa2-830f2434f482', email: 'owner@example.invalid' }, email_data: { email_action_type: 'recovery', token_hash: 'SECRET_TOKEN' } };
let reads = 0;
let sent: string[] = [];
const dependencies: AuthEmailDependencies = {
  verify: () => event,
  lookupProfile: async (id) => {
    assert.equal(id, event.user.id);
    reads++;
    return { room_deletion_requested_at: '2026-11-03', room_purge_after: '2027-02-04' };
  },
  send: async mail => { sent.push(JSON.stringify(mail)); },
  authUrl: 'https://project.supabase.co', siteUrl: 'https://staysee.ru',
};
const request = () => new Request('https://hook.invalid', { method: 'POST', body: '{}' });
assert.equal((await createAuthEmailHandler(dependencies)(request())).status, 200);
assert.equal(reads, 1);
assert.equal(sent.length, 1);
assert.ok(!sent[0].includes('SECRET_TOKEN'));

reads = 0; sent = [];
const badSignature = createAuthEmailHandler({ ...dependencies, verify: () => { throw new Error('signature SECRET_TOKEN'); } });
const denied = await badSignature(request());
assert.equal(denied.status, 401);
assert.ok(!(await denied.text()).includes('SECRET_TOKEN'));
assert.equal(reads, 0); assert.equal(sent.length, 0);

const dbFailure = createAuthEmailHandler({ ...dependencies, lookupProfile: async () => { throw new Error('db owner@example.invalid'); } });
const failure = await dbFailure(request());
assert.equal(failure.status, 503);
assert.ok(!(await failure.text()).includes('owner@'));
assert.equal(sent.length, 0);
assert.equal((await createAuthEmailHandler({ ...dependencies, send: async () => { throw new Error('SMTP secret'); } })(request())).status, 503);
assert.equal((await createAuthEmailHandler({ ...dependencies, verify: () => ({ ...event, user: { id: '../../other' } }) })(request())).status, 400);
assert.equal((await createAuthEmailHandler(dependencies)(new Request('https://hook.invalid'))).status, 405);
assert.equal((await createAuthEmailHandler(dependencies)(new Request('https://hook.invalid', { method: 'POST', body: 'x'.repeat(65537) }))).status, 413);
let abortedLookup = false;
const slowLookup = createAuthEmailHandler({ ...dependencies, lookupProfile: async (_id, signal) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => { abortedLookup = true; reject(new Error('aborted')); }, { once: true });
}) }, 20);
assert.equal((await slowLookup(request())).status, 503);
assert.equal(abortedLookup, true);
let started = 0;
let releaseFirst: (() => void) | undefined;
const pair = createAuthEmailHandler({ ...dependencies,
  verify: () => ({ ...event, user: { ...event.user, new_email: 'new@example.invalid' }, email_data: { email_action_type: 'email_change', token_hash: 'new', token_hash_new: 'old' } }),
  lookupProfile: async () => null,
  send: async () => {
    started++;
    if (started === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
    else releaseFirst?.();
  },
}, 40);
assert.equal((await pair(request())).status, 200);
assert.equal(started, 2);
let siblingCancelled = false;
const partial = createAuthEmailHandler({ ...dependencies,
  verify: () => ({ ...event, user: { ...event.user, new_email: 'new@example.invalid' }, email_data: { email_action_type: 'email_change', token_hash: 'new', token_hash_new: 'old' } }),
  lookupProfile: async () => null,
  send: async (mail, signal) => {
    if (mail.to === event.user.email) throw new Error('SMTP refused');
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { siblingCancelled = true; reject(new Error('cancelled')); }, { once: true }));
  },
});
assert.equal((await partial(request())).status, 503);
assert.equal(siblingCancelled, true);
const slowSmtp = createAuthEmailHandler({ ...dependencies, send: async (_mail, signal) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new Error('aborted send')), { once: true });
}) }, 20);
assert.equal((await slowSmtp(request())).status, 503);
console.log('authEmailHandler cases passed');
