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

const scrollingTextarea = {
  scrollHeight: 400,
  scrollTop: 0,
  style: { height: '24px' },
};
resizeChatComposer(scrollingTextarea, 120, true);
assertEqual(
  scrollingTextarea.scrollTop,
  400,
  'live dictation that overflows the cap keeps the newest text in view',
);

const typedTextarea = {
  scrollHeight: 400,
  scrollTop: 0,
  style: { height: '24px' },
};
resizeChatComposer(typedTextarea);
assertEqual(
  typedTextarea.scrollTop,
  0,
  'ordinary typing is untouched by default -- the browser already follows the caret, and forcing the scroll position would fight a person who scrolled up on purpose',
);

console.log('chatComposerLayout.cases.test.ts — all passed');
