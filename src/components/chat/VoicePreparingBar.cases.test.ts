import React, { isValidElement, type ReactElement, type ReactNode } from 'react';

Object.assign(globalThis, { React });
const { VoicePreparingBar } = await import('./VoicePreparingBar');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function childrenOf(node: ReactNode): ReactNode[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const children = node.props.children;
  if (Array.isArray(children)) return children;
  return children === undefined || children === null ? [] : [children];
}

function walk(node: ReactNode, visit: (value: ReactNode) => void): void {
  visit(node);
  for (const child of childrenOf(node)) walk(child, visit);
}

function findByProp(
  root: ReactNode,
  name: string,
  value: unknown,
): ReactElement<Record<string, unknown>> {
  let match: ReactElement<Record<string, unknown>> | null = null;
  walk(root, (node) => {
    if (!isValidElement<Record<string, unknown>>(node)) return;
    if (node.props[name] === value) match = node;
  });
  if (match === null) throw new Error(`missing ${name}=${String(value)}`);
  return match as ReactElement<Record<string, unknown>>;
}

function includesText(root: ReactNode, expected: string): boolean {
  let matched = false;
  walk(root, (node) => {
    if (typeof node === 'string' && node.includes(expected)) matched = true;
  });
  return matched;
}

let cancelCalls = 0;
const downloading = VoicePreparingBar({
  progress: { loadedBytes: 41_000_000, totalBytes: 83_239_825 },
  onCancel: () => { cancelCalls += 1; },
  textClass: 'text-test',
  mutedClass: 'muted-test',
});

const status = findByProp(downloading, 'role', 'status');
assert(status.props['aria-live'] === 'polite', 'the download is announced politely');
assert(includesText(downloading, 'Скачиваю голосовой пакет'), 'the row says what is happening');
assert(includesText(downloading, '41 из 83 МБ'), 'the byte counter is visible');

const bar = findByProp(downloading, 'role', 'progressbar');
assert(bar.props['aria-valuenow'] === 49, 'the bar reports the real percentage');
assert(bar.props['aria-valuemin'] === 0, 'the bar has a floor');
assert(bar.props['aria-valuemax'] === 100, 'the bar has a ceiling');
assert(bar.props['data-voice-progress'] === 'determinate', 'a byte download has a real bar');

const fill = findByProp(downloading, 'data-voice-progress-fill', 'fill');
assert(
  (fill.props.style as { width?: string } | undefined)?.width === '49%',
  'the fill width follows the percentage',
);

const cancel = findByProp(downloading, 'aria-label', 'Отменить загрузку голосового пакета');
assert(cancel.props.type === 'button', 'cancel is a button');
(cancel.props.onClick as () => void)();
assert(cancelCalls === 1, 'cancel handler called once');

const opening = VoicePreparingBar({
  progress: null,
  onCancel: () => undefined,
  textClass: 'text-test',
  mutedClass: 'muted-test',
});
assert(includesText(opening, 'Готовлю голосовой движок'), 'the indeterminate stage says so');
assert(
  !includesText(opening, 'МБ'),
  'an indeterminate stage never shows a byte counter it does not have',
);
const openingBar = findByProp(opening, 'role', 'progressbar');
assert(
  openingBar.props['aria-valuenow'] === undefined,
  'an indeterminate bar claims no value rather than claiming zero',
);
assert(
  openingBar.props['data-voice-progress'] === 'indeterminate',
  'the indeterminate state is marked for styling and for this test',
);
const openingFill = findByProp(opening, 'data-voice-progress-fill', 'fill');
assert(
  (openingFill.props.className as string).includes('animate-pulse'),
  'the indeterminate bar pulses instead of sitting at a dead zero',
);
assert(
  (openingFill.props.className as string).includes('motion-reduce:animate-none'),
  'reduced motion is respected, as the existing voice wave already does',
);

const startOfDownload = VoicePreparingBar({
  progress: { loadedBytes: 0, totalBytes: 83_239_825 },
  onCancel: () => undefined,
  textClass: 'text-test',
  mutedClass: 'muted-test',
});
assert(
  findByProp(startOfDownload, 'role', 'progressbar').props['aria-valuenow'] === 0,
  'a download that just opened reads zero, not indeterminate',
);
assert(includesText(startOfDownload, '0 из 83 МБ'), 'the counter is there from the first frame');

console.log('VoicePreparingBar.cases.test.ts — all passed');
