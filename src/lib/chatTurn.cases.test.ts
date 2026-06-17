/**
 * Turn id reuse for submit/retry.
 * Run: npx tsx src/lib/chatTurn.cases.test.ts
 */

import { resolveTurnId } from './chatTurn';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const turnA = '11111111-1111-4111-8111-111111111111';
const turnB = '22222222-2222-4222-8222-222222222222';

assert(
  resolveTurnId({ turnId: turnA, content: 'Привет' }, 'Привет') === turnA,
  'retry same content reuses turnId',
);

assert(
  resolveTurnId({ turnId: turnA, content: 'Привет' }, 'Другой текст') !== turnA,
  'new content gets new turnId',
);

assert(
  resolveTurnId(null, 'Новое') !== turnB,
  'fresh turn when no pending',
);

console.log('chatTurn.cases.test.ts — all passed');
