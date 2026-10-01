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
  firstSeenAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
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
// firstSeenAt === updatedAt -- never revised since it was first recorded.
assert.match(html, /Записано:/u);
assert.doesNotMatch(html, /Обновлено:/u);

// A second fixture whose updatedAt is later than firstSeenAt -- the reducer
// only moves updatedAt forward on a real material change, so this is exactly
// the signal Настя asked to surface: "has this genuinely changed since".
const revisedItem = { ...item, memoryKey: 'profile:job', updatedAt: '2026-09-15T00:00:00Z' };
const revisedHtml = renderToStaticMarkup(
  <MemoryV3ItemList
    items={[revisedItem]}
    theme={theme as never}
    cardBase="card"
    readOnly
    emptyMessage="Пока пусто"
    topicLabels={{ communication: 'Общение' }}
  />,
);
assert.match(revisedHtml, /Обновлено:/u);
assert.doesNotMatch(revisedHtml, /Записано:/u);

console.log('memoryV3ItemList.cases.test.tsx — all passed');
