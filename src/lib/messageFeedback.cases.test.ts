/**
 * Rules of the thumbs under an answer (src/lib/messageFeedback.ts).
 * Run: npx tsx src/lib/messageFeedback.cases.test.ts
 */

import {
  FEEDBACK_COMMENT_MAX,
  canMarkMessage,
  loadFeedback,
  normalizeFeedbackComment,
  pressThumb,
  saveComment,
  type FeedbackDbError,
  type FeedbackDeps,
  type FeedbackState,
} from './messageFeedback.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function same(actual: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

const target = { conversationId: 'conv-1', messageId: 'msg-1' };

/** A fake database that records what was asked and fails on demand. */
function fakeDeps(
  options: {
    insertError?: FeedbackDbError;
    updateError?: FeedbackDbError;
    removeError?: FeedbackDbError;
    fetchRows?: Array<{ message_id: string; rating: number; comment: string | null }>;
    fetchError?: FeedbackDbError;
  } = {},
) {
  const calls: string[] = [];
  const deps: FeedbackDeps = {
    insert: async (row) => {
      calls.push(`insert ${row.rating} ${row.comment}`);
      return { error: options.insertError ?? null };
    },
    update: async (messageId, patch) => {
      calls.push(`update ${messageId} ${JSON.stringify(patch)}`);
      return { error: options.updateError ?? null };
    },
    remove: async (messageId) => {
      calls.push(`remove ${messageId}`);
      return { error: options.removeError ?? null };
    },
    fetch: async (ids) => {
      calls.push(`fetch ${ids.length}`);
      return { data: options.fetchError ? null : (options.fetchRows ?? []), error: options.fetchError ?? null };
    },
  };
  return { deps, calls };
}

// ── pressing a thumb ────────────────────────────────────────────────────────────────────────────────────
{
  const { deps, calls } = fakeDeps();
  same(await pressThumb(deps, target, null, -1), { ok: true, next: { rating: -1, comment: null } }, 'adds a mark when there is none');
  same(calls, ['insert -1 null'], 'one insert');
}
{
  const { deps, calls } = fakeDeps();
  same(await pressThumb(deps, target, { rating: 1, comment: 'понравилось' }, 1), { ok: true, next: null }, 'the same thumb again takes the mark back');
  same(calls, ['remove msg-1'], 'one remove');
}
{
  const { deps, calls } = fakeDeps();
  same(await pressThumb(deps, target, { rating: 1, comment: 'понравилось' }, -1), { ok: true, next: { rating: -1, comment: null } }, 'the other thumb changes the mark and drops the note');
  same(calls, ['update msg-1 {"rating":-1,"comment":null}'], 'one update');
}
{
  const { deps, calls } = fakeDeps({ insertError: { code: '23505' } });
  same(await pressThumb(deps, target, null, 1), { ok: true, next: { rating: 1, comment: null } }, 'marked a moment ago somewhere else: the new mark stands, no error');
  same(calls, ['insert 1 null', 'update msg-1 {"rating":1,"comment":null}'], 'insert, then the existing row is changed');
}
{
  const before: FeedbackState = { rating: 1, comment: 'хорошо' };
  const cases: Array<[string, Parameters<typeof fakeDeps>[0], FeedbackState | null, 1 | -1]> = [
    ['add', { insertError: { code: '42501' } }, null, 1],
    ['remove', { removeError: { code: 'x' } }, before, 1],
    ['change', { updateError: { code: 'x' } }, before, -1],
    ['collision then failed update', { insertError: { code: '23505' }, updateError: { code: 'x' } }, null, 1],
  ];
  for (const [label, options, current, rating] of cases) {
    const { deps } = fakeDeps(options);
    const result = await pressThumb(deps, target, current, rating);
    assert(result.ok === false, `${label}: reported as failed`);
    same(result.next, current, `${label}: the screen stays as it was`);
  }
}

// ── the short note ──────────────────────────────────────────────────────────────────────────────────────
{
  const { deps, calls } = fakeDeps();
  same(
    await saveComment(deps, target, { rating: -1, comment: null }, '   слишком длинно и без вопроса   '),
    { ok: true, next: { rating: -1, comment: 'слишком длинно и без вопроса' } },
    'the note is saved trimmed, on the existing mark',
  );
  same(calls, ['update msg-1 {"comment":"слишком длинно и без вопроса"}'], 'only the note is updated');
}
{
  const { deps, calls } = fakeDeps();
  const state: FeedbackState = { rating: 1, comment: null };
  for (const text of ['', '   ', '\n\n']) same(await saveComment(deps, target, state, text), { ok: true, next: state }, 'a blank note is not an error');
  same(calls, [], 'a blank note sends nothing');
}
{
  const { deps, calls } = fakeDeps();
  assert((await saveComment(deps, target, null, 'текст')).ok === false, 'a note needs a mark first');
  same(calls, [], 'nothing sent without a mark');
}
{
  const { deps } = fakeDeps({ updateError: { code: 'x' } });
  const state: FeedbackState = { rating: 1, comment: 'старое' };
  same(await saveComment(deps, target, state, 'новое'), { ok: false, next: state }, 'the old note stays when saving fails');
}
{
  assert(normalizeFeedbackComment(null) === null && normalizeFeedbackComment('  ') === null, 'nothing is stored empty');
  assert(normalizeFeedbackComment('я'.repeat(FEEDBACK_COMMENT_MAX + 50))?.length === FEEDBACK_COMMENT_MAX, 'cut to the limit');
  assert(FEEDBACK_COMMENT_MAX <= 1000, 'the box stops before the table limit');
}

// ── showing the marks again after a reload ──────────────────────────────────────────────────────────────
{
  const ids = Array.from({ length: 230 }, (_, i) => `m${i}`);
  const { deps, calls } = fakeDeps({ fetchRows: [{ message_id: 'm1', rating: -1, comment: 'не то' }, { message_id: 'm2', rating: 5, comment: null }] });
  const marks = await loadFeedback(deps, ids);
  same(calls, ['fetch 100', 'fetch 100', 'fetch 30'], 'read in groups of 100');
  same(marks.m1, { rating: -1, comment: 'не то' }, 'a valid mark comes back');
  assert(marks.m2 === undefined, 'a rating that is not +1 or -1 is ignored');
}
{
  const { deps } = fakeDeps({ fetchError: { code: 'x' } });
  same(await loadFeedback(deps, ['a', 'b']), {}, 'a failed read is silent');
}

// ── which messages can be marked ────────────────────────────────────────────────────────────────────────
assert(canMarkMessage({ id: 'abc', sender: 'ai', content: 'ответ' }), 'a saved answer of Stacy');
assert(!canMarkMessage({ id: 'abc', sender: 'user', content: 'вопрос' }), 'not the person\'s own message');
assert(!canMarkMessage({ id: 'stream-1', sender: 'ai', content: 'пишется' }), 'not an answer that is still being written');
assert(!canMarkMessage({ id: 'temp-1', sender: 'ai', content: 'ещё не сохранено' }), 'not an answer that is not saved yet');
assert(!canMarkMessage({ id: 'abc', sender: 'ai', content: '' }), 'not an empty one');

console.log('All messageFeedback cases passed.');
