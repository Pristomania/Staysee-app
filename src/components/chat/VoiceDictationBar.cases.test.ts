import React, { isValidElement, type ReactElement, type ReactNode } from 'react';

Object.assign(globalThis, { React });
const { VoiceDictationBar } = await import('./VoiceDictationBar');

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

function countVoiceBars(root: ReactNode): number {
  let count = 0;
  walk(root, (node) => {
    if (!isValidElement<Record<string, unknown>>(node)) return;
    if (typeof node.props['data-voice-bar'] === 'string') count += 1;
  });
  return count;
}

let stopCalls = 0;
const tree = VoiceDictationBar({
  elapsedMs: 65_000,
  level: 0.5,
  phase: 'listening',
  onStop: () => { stopCalls += 1; },
  textClass: 'text-test',
  mutedClass: 'muted-test',
});

const status = findByProp(tree, 'role', 'status');
assert(status.props['aria-live'] === 'polite', 'recording state is announced politely');
assert(includesText(tree, 'Слушаю…'), 'visible listening label');
assert(includesText(tree, '1:05'), 'visible duration');
assert(countVoiceBars(tree) === 9, 'nine deterministic voice bars');

const stopButton = findByProp(tree, 'aria-label', 'Остановить голосовой ввод');
assert(stopButton.props.type === 'button', 'stop control is a button');
assert(typeof stopButton.props.onClick === 'function', 'stop handler exists');
(stopButton.props.onClick as () => void)();
assert(stopCalls === 1, 'stop handler called once');

const fallbackTree = VoiceDictationBar({
  elapsedMs: 0,
  level: 0,
  phase: 'starting',
  onStop: () => undefined,
  textClass: 'text-test',
  mutedClass: 'muted-test',
});
assert(
  findByProp(fallbackTree, 'data-voice-wave', 'fallback').props.className
    ?.toString().includes('voice-wave-fallback'),
  'zero level uses calm fallback animation',
);

console.log('VoiceDictationBar.cases.test.ts — all passed');
