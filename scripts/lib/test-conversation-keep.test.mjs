import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  removeStaleTestConversations,
  selectStaleTestConversations,
  shouldDeleteTestConversationNow,
  withTestConversation,
} from './prod-test-env.mjs';

// Test conversations used to be deleted the moment a test ended, which raised false alerts when memory was still
// writing and destroyed the evidence needed to find out why a run failed. They are now KEPT, and the next test run
// (or `cleanup-prod-test-conversations.mjs --apply --older-than-minutes 60`) removes the ones older than an hour.

const NOW = Date.parse('2026-10-20T18:00:00.000Z');
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const USER = '5349a89a-4cc5-4338-b841-8a5723c95d8f';

describe('which test conversations are stale', () => {
  const rows = [
    { id: 'old-test', title: '__TEST__ smoke', created_at: minutesAgo(90) },
    { id: 'fresh-test', title: '__TEST__ smoke', created_at: minutesAgo(10) },
    { id: 'old-real', title: 'Сокровенное', created_at: minutesAgo(5000) },
    { id: 'edge-test', title: '__TEST__ edge', created_at: minutesAgo(60) },
  ];

  it('takes only test conversations older than the limit (an hour by default)', () => {
    const ids = selectStaleTestConversations(rows, { now: NOW }).map((row) => row.id);
    assert.deepEqual(ids.sort(), ['edge-test', 'old-test']);
  });

  it('never takes a conversation that is not marked as a test, however old', () => {
    assert.equal(selectStaleTestConversations(rows, { now: NOW, olderThanMinutes: 0 }).some((row) => row.id === 'old-real'), false);
  });

  it('takes every test conversation when the limit is zero', () => {
    assert.equal(selectStaleTestConversations(rows, { now: NOW, olderThanMinutes: 0 }).length, 3);
  });
});

describe('deleting right away has to be asked for', () => {
  it('keeps conversations unless STAYSEE_TEST_DELETE_NOW=1', () => {
    assert.equal(shouldDeleteTestConversationNow({}), false);
    assert.equal(shouldDeleteTestConversationNow({ STAYSEE_TEST_DELETE_NOW: '0' }), false);
    assert.equal(shouldDeleteTestConversationNow({ STAYSEE_TEST_DELETE_NOW: '1' }), true);
  });
});

describe('withTestConversation', () => {
  const realFetch = globalThis.fetch;
  const savedEnv = process.env.STAYSEE_TEST_DELETE_NOW;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedEnv === undefined) delete process.env.STAYSEE_TEST_DELETE_NOW;
    else process.env.STAYSEE_TEST_DELETE_NOW = savedEnv;
  });

  function stubDatabase(staleRows = []) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url: String(url) });
      const path = String(url).split('/rest/v1/')[1] ?? '';
      let body = '[]';
      if (method === 'POST' && path.startsWith('conversations')) body = JSON.stringify([{ id: 'new-conversation' }]);
      if (method === 'GET' && path.startsWith('conversations?')) body = JSON.stringify(staleRows);
      return new Response(body, { status: 200 });
    };
    return calls;
  }
  const run = (fn) => withTestConversation({ url: 'http://127.0.0.1:54321', serviceKey: 'k', testUserId: USER }, 'unit', fn);
  const deletes = (calls) => calls.filter((call) => call.method === 'DELETE' && call.url.includes('conversations?id=eq.'));

  it('keeps the conversation it created, and says so', async () => {
    delete process.env.STAYSEE_TEST_DELETE_NOW;
    const calls = stubDatabase();
    await run(async () => {});
    assert.deepEqual(deletes(calls), []);
  });

  it('keeps it even when the test itself fails, so the evidence survives', async () => {
    delete process.env.STAYSEE_TEST_DELETE_NOW;
    const calls = stubDatabase();
    await assert.rejects(() => run(async () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(deletes(calls), []);
  });

  it('deletes it at the end when STAYSEE_TEST_DELETE_NOW=1', async () => {
    process.env.STAYSEE_TEST_DELETE_NOW = '1';
    const calls = stubDatabase();
    await run(async () => {});
    assert.equal(deletes(calls).length, 1);
    assert.match(deletes(calls)[0].url, /conversations\?id=eq\.new-conversation/);
  });

  it('first removes this account\'s test conversations that are over an hour old, and only those', async () => {
    delete process.env.STAYSEE_TEST_DELETE_NOW;
    const calls = stubDatabase([
      { id: 'stale-1', title: '__TEST__ old', created_at: new Date(Date.now() - 3 * 3600_000).toISOString() },
      { id: 'fresh-1', title: '__TEST__ fresh', created_at: new Date(Date.now() - 5 * 60_000).toISOString() },
      { id: 'real-1', title: 'Мой дневник', created_at: new Date(Date.now() - 9 * 3600_000).toISOString() },
    ]);
    await run(async () => {});
    const removed = deletes(calls).map((call) => call.url.split('id=eq.')[1]);
    assert.deepEqual(removed, ['stale-1']);
  });

  it('does not let a failed cleanup of old conversations stop the test', async () => {
    delete process.env.STAYSEE_TEST_DELETE_NOW;
    let created = false;
    globalThis.fetch = async (url, init = {}) => {
      const method = init.method ?? 'GET';
      const path = String(url).split('/rest/v1/')[1] ?? '';
      if (method === 'GET' && path.startsWith('conversations?')) return new Response('boom', { status: 500 });
      if (method === 'POST' && path.startsWith('conversations')) {
        created = true;
        return new Response(JSON.stringify([{ id: 'c1' }]), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    };
    await run(async () => {});
    assert.equal(created, true);
  });
});

describe('removeStaleTestConversations', () => {
  it('reports how many it removed', async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, init = {}) => {
        const method = init.method ?? 'GET';
        const path = String(url).split('/rest/v1/')[1] ?? '';
        if (method === 'GET' && path.startsWith('conversations?')) {
          return new Response(JSON.stringify([
            { id: 'a', title: '__TEST__ x', created_at: minutesAgo(120) },
            { id: 'b', title: '__TEST__ y', created_at: minutesAgo(130) },
          ]), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      };
      const removed = await removeStaleTestConversations('http://127.0.0.1:54321', {}, USER, { now: NOW, log: () => {} });
      assert.equal(removed, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
