/**
 * Thumbs on the weekly "Динамика" (src/lib/dynamicsFeedbackDeps.ts, migration 096).
 * Run: npx tsx src/lib/dynamicsFeedback.cases.test.ts
 *
 * The rules (one mark per item, the other thumb changes the mark and drops the note, an empty note is nothing) are the ones of
 * messageFeedback.ts and are tested in messageFeedback.cases.test.ts. Here: the steps hit the right table and the right column
 * (entry_id), and the screen gets its own words.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createDynamicsFeedbackDeps, DYNAMICS_FEEDBACK_COPY } from './dynamicsFeedbackDeps.ts';
import { FEEDBACK_COPY, loadFeedback, pressThumb, saveComment } from './messageFeedback.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function same(actual: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

interface Call {
  table: string;
  op: string;
  payload?: unknown;
  filters: Array<[string, unknown]>;
  selected?: string;
}

/** A fake client that records what was asked of the table and answers with the given data or error. */
function fakeClient(result: { data?: unknown; error?: { code: string } | null } = {}) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] };
      calls.push(call);
      const answer = { data: result.data ?? null, error: result.error ?? null };
      const chain = {
        insert(payload: unknown) {
          call.op = 'insert';
          call.payload = payload;
          return chain;
        },
        update(payload: unknown) {
          call.op = 'update';
          call.payload = payload;
          return chain;
        },
        delete() {
          call.op = 'delete';
          return chain;
        },
        select(columns: string) {
          call.selected = columns;
          return chain;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return chain;
        },
        in(column: string, value: unknown) {
          call.filters.push([column, value]);
          return chain;
        },
        then(resolve: (value: typeof answer) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve(answer).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const target = { conversationId: 'conv-1', messageId: 'entry-1' };

// ── a new mark goes to dynamics_feedback with the id of the dynamics as entry_id ─────────────────────────
{
  const { client, calls } = fakeClient();
  const result = await pressThumb(createDynamicsFeedbackDeps(client), target, null, 1);
  same(result, { ok: true, next: { rating: 1, comment: null } }, 'a new mark');
  assert(calls.length === 1, 'one call');
  assert(calls[0]!.table === 'dynamics_feedback' && calls[0]!.op === 'insert', 'inserted into dynamics_feedback');
  same(calls[0]!.payload, { conversation_id: 'conv-1', entry_id: 'entry-1', rating: 1, comment: null }, 'the row');
  console.log('✓ a new mark: dynamics_feedback, entry_id');
}

// ── changing the mark updates the row of that dynamics, nothing else ─────────────────────────────────────
{
  const { client, calls } = fakeClient();
  const result = await pressThumb(createDynamicsFeedbackDeps(client), target, { rating: 1, comment: 'было хорошо' }, -1);
  same(result, { ok: true, next: { rating: -1, comment: null } }, 'changed');
  assert(calls[0]!.op === 'update', 'an update');
  same(calls[0]!.payload, { rating: -1, comment: null }, 'the patch');
  same(calls[0]!.filters, [['entry_id', 'entry-1']], 'only that dynamics');
  console.log('✓ changing the mark: one row, by entry_id');
}

// ── pressing the same thumb again removes the mark of that dynamics ──────────────────────────────────────
{
  const { client, calls } = fakeClient();
  const result = await pressThumb(createDynamicsFeedbackDeps(client), target, { rating: 1, comment: null }, 1);
  same(result, { ok: true, next: null }, 'removed');
  assert(calls[0]!.op === 'delete', 'a delete');
  same(calls[0]!.filters, [['entry_id', 'entry-1']], 'only that dynamics');
  console.log('✓ the same thumb again takes the mark back');
}

// ── a note is saved on the row of that dynamics ──────────────────────────────────────────────────────────
{
  const { client, calls } = fakeClient();
  const result = await saveComment(createDynamicsFeedbackDeps(client), target, { rating: -1, comment: null }, '  не про меня  ');
  same(result, { ok: true, next: { rating: -1, comment: 'не про меня' } }, 'the note');
  assert(calls[0]!.op === 'update', 'an update');
  same(calls[0]!.payload, { comment: 'не про меня' }, 'only the note');
  same(calls[0]!.filters, [['entry_id', 'entry-1']], 'only that dynamics');
  console.log('✓ a note is saved on that dynamics');
}

// ── a mark made a moment ago in another window is not an error: the existing row is changed ──────────────
{
  const calls: string[] = [];
  const client = {
    from() {
      return {
        insert() {
          calls.push('insert');
          return Promise.resolve({ error: { code: '23505' } });
        },
        update() {
          calls.push('update');
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
  } as unknown as SupabaseClient;
  const result = await pressThumb(createDynamicsFeedbackDeps(client), target, null, 1);
  same(result, { ok: true, next: { rating: 1, comment: null } }, 'the mark stands');
  same(calls, ['insert', 'update'], 'insert, then update');
  console.log('✓ a double mark is not an error');
}

// ── a failed save reports the error and leaves the screen as it was ──────────────────────────────────────
{
  const { client } = fakeClient({ error: { code: '42501' } });
  const before = { rating: 1 as const, comment: null };
  const result = await pressThumb(createDynamicsFeedbackDeps(client), target, before, -1);
  same(result, { ok: false, next: before }, 'unchanged');
  console.log('✓ a failed save leaves the screen as it was');
}

// ── the marks already given are read again by entry_id and handed back under the id the screen knows ─────
{
  const { client, calls } = fakeClient({
    data: [
      { entry_id: 'entry-1', rating: 1, comment: null },
      { entry_id: 'entry-2', rating: -1, comment: 'не про меня' },
    ],
  });
  const found = await loadFeedback(createDynamicsFeedbackDeps(client), ['entry-1', 'entry-2', 'entry-3']);
  same(found, { 'entry-1': { rating: 1, comment: null }, 'entry-2': { rating: -1, comment: 'не про меня' } }, 'the marks');
  assert(calls[0]!.table === 'dynamics_feedback', 'read from dynamics_feedback');
  assert(calls[0]!.selected === 'entry_id, rating, comment', 'the columns');
  same(calls[0]!.filters, [['entry_id', ['entry-1', 'entry-2', 'entry-3']]], 'by entry_id');
  console.log('✓ the marks come back after a reload');
}

// ── the words under a dynamics ───────────────────────────────────────────────────────────────────────────
for (const key of Object.keys(FEEDBACK_COPY) as Array<keyof typeof FEEDBACK_COPY>) {
  assert(typeof DYNAMICS_FEEDBACK_COPY[key] === 'string' && DYNAMICS_FEEDBACK_COPY[key].length > 0, `the words have "${key}"`);
}
assert(DYNAMICS_FEEDBACK_COPY.good !== FEEDBACK_COPY.good && DYNAMICS_FEEDBACK_COPY.bad !== FEEDBACK_COPY.bad, 'the thumbs name a dynamics, not an answer');
assert(/динамик/i.test(DYNAMICS_FEEDBACK_COPY.good) && /динамик/i.test(DYNAMICS_FEEDBACK_COPY.bad), 'the thumbs say "динамика"');

// The app does not know the gender of the person: no past-tense word that has one. «подошла» agrees with «динамика», not with the person.
const ALLOWED_WORDS = new Set(['подошла']);
for (const [key, text] of Object.entries(DYNAMICS_FEEDBACK_COPY)) {
  const found = text.split(/[^а-яёА-ЯЁ]+/u).filter((word) => /^[а-яё]+(ла|л)$/iu.test(word) && !ALLOWED_WORDS.has(word.toLowerCase()));
  assert(found.length === 0, `the text "${key}" has no form that assumes the gender of the person (${found.join(', ')})`);
}
console.log('✓ the words under a dynamics');

console.log('All dynamicsFeedback cases passed.');
