import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSchema } from './backfill-topics.ts';

describe('Memory V3 topic backfill schema', () => {
  it('builds a strict schema restricted to exactly the given topics', () => {
    const schema = buildSchema(['life_context', 'communication', 'preference']);
    assert.deepEqual(schema.properties.topic.enum, ['life_context', 'communication', 'preference']);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['topic']);
  });

  it('builds an independent schema for the dialogue topic set', () => {
    const schema = buildSchema(['person', 'fact', 'preference']);
    assert.deepEqual(schema.properties.topic.enum, ['person', 'fact', 'preference']);
  });
});
