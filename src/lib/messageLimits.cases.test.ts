import {
  MAX_MESSAGE_CHARS,
  messageLengthHint,
  messageLengthState,
} from './messageLimits.ts';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const text = (n: number) => 'а'.repeat(n);

// The maximum is 10,000 characters per message.
assertEqual(MAX_MESSAGE_CHARS, 10_000, 'maximum');

// It counts what is sent: the text without leading and trailing blanks.
assertEqual(messageLengthState('  привет  ').length, 6, 'trimmed length');
assertEqual(messageLengthState('').length, 0, 'empty length');

// Exactly the maximum is accepted, one more is refused.
assertEqual(messageLengthState(text(10_000)).tooLong, false, 'maximum accepted');
assertEqual(messageLengthState(text(10_001)).tooLong, true, 'one over refused');
assertEqual(messageLengthState(text(10_001)).overBy, 1, 'over by one');
assertEqual(messageLengthState(text(9_000)).overBy, 0, 'not over');

// No counter in the chat: it distracts. Nothing is shown for any text up to the maximum, however close to it.
assertEqual(messageLengthHint(messageLengthState('Привет')), null, 'normal message');
assertEqual(messageLengthHint(messageLengthState(text(8_500))), null, 'no count near the limit');
assertEqual(messageLengthHint(messageLengthState(text(10_000))), null, 'no count at the maximum');

// Only a text that is too long gets a line, because Send does not work and the person needs to know why.
assertEqual(
  messageLengthHint(messageLengthState(text(10_340))),
  'Слишком длинно: 10\u00a0340 из 10\u00a0000. Раздели на части.',
  'text too long',
);

console.log('messageLimits: all checks passed');
