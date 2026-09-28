import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

Object.assign(globalThis, { React });
const { MemoryV3ItemList } = await import('../../../../src/components/MemoryV3ItemList.tsx');

const theme = {
  textPrimary: 'text-primary',
  textSecondary: 'text-secondary',
  textMuted: 'text-muted',
  surface: 'surface',
  surfaceHover: 'surface-hover',
  border: 'border',
  spinnerBorder: 'spinner-border',
  spinnerTop: 'spinner-top',
} as const;

const item = {
  memoryKey: 'profile:name',
  kind: 'event' as const,
  claim: 'Пользователь предпочитает прямой тон.',
  eventTimeStart: null,
  eventTimeEnd: null,
  sensitivity: 'normal' as const,
  topic: 'communication',
};

const html = renderToStaticMarkup(
  <MemoryV3ItemList
    items={[item]}
    theme={theme as never}
    cardBase="card"
    readOnly
    emptyMessage="Пока пусто"
    topicLabels={{ communication: 'Общение' }}
  />,
);

assert.match(html, /Пользователь предпочитает прямой тон/u);
assert.doesNotMatch(html, /<button/u, 'read-only list must not render delete controls');

console.log('memoryV3ItemList.cases.test.tsx — all passed');
