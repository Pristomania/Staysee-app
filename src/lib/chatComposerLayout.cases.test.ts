import { resizeChatComposer } from './chatComposerLayout';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
  }
}

const textarea = {
  scrollHeight: 84,
  style: { height: '24px' },
};

resizeChatComposer(textarea);
assertEqual(textarea.style.height, '84px', 'programmatic transcript expands the composer');

textarea.scrollHeight = 28;
resizeChatComposer(textarea);
assertEqual(textarea.style.height, '28px', 'shorter draft shrinks the composer again');

console.log('chatComposerLayout.cases.test.ts — all passed');
