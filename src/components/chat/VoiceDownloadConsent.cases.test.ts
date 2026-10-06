import React, { isValidElement, type ReactElement, type ReactNode } from 'react';

Object.assign(globalThis, { React });
const { VoiceDownloadConsent } = await import('./VoiceDownloadConsent');

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

const state: { accepts: number; cancels: number } = { accepts: 0, cancels: 0 };
const tree = VoiceDownloadConsent({
  sizeLabel: '83 МБ',
  onAccept: () => { state.accepts += 1; },
  onCancel: () => { state.cancels += 1; },
  borderClass: 'border-test',
  surfaceClass: 'surface-test',
  textClass: 'text-test',
  mutedClass: 'muted-test',
});

const group = findByProp(tree, 'role', 'group');
assert(group.props['aria-live'] === 'polite', 'the card announces itself politely');
assert(
  group.props['aria-label'] === 'Загрузка голосового пакета',
  'the card names what it is about',
);

assert(includesText(tree, '83 МБ'), 'the size is stated before anything downloads');
assert(
  includesText(tree, 'один раз'),
  'the card promises this is a one-time download, which is the whole bargain',
);
assert(
  includesText(tree, 'не отправляется'),
  'the card states the privacy promise that justifies the download',
);

const download = findByProp(tree, 'aria-label', 'Скачать голосовой пакет');
assert(download.props.type === 'button', 'download is a button');
(download.props.onClick as () => void)();
assert((state.accepts as number) === 1, 'download handler called once');
assert((state.cancels as number) === 0, 'download does not also cancel');

const cancel = findByProp(tree, 'aria-label', 'Отказаться от загрузки голосового пакета');
assert(cancel.props.type === 'button', 'cancel is a button');
(cancel.props.onClick as () => void)();
assert((state.cancels as number) === 1, 'cancel handler called once');
assert((state.accepts as number) === 1, 'cancel does not also download');

assert(includesText(tree, 'Скачать'), 'the affirmative button is labelled in plain Russian');
assert(includesText(tree, 'Отмена'), 'the declining button is labelled in plain Russian');

console.log('VoiceDownloadConsent.cases.test.ts — all passed');
