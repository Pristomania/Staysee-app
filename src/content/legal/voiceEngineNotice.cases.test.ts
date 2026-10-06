/**
 * Run: npx tsx src/content/legal/voiceEngineNotice.cases.test.ts
 */

function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message = 'values must be equal'): void {
  assert(Object.is(actual, expected), `${message}: ${String(actual)} !== ${String(expected)}`);
}

async function runCase(name: string, callback: () => void | Promise<void>): Promise<void> {
  await callback();
  console.log(`PASS: ${name}`);
}

import {
  VOICE_ENGINE_CREDITS,
  VOICE_ENGINE_LICENCE_NOTE,
  VOICE_ENGINE_LICENCE_URL,
  VOICE_ENGINE_NOTICE_BODY,
  VOICE_ENGINE_NOTICE_TITLE,
} from './voiceEngineNotice';

await runCase('both Apache-licensed components are credited', () => {
  // Apache 2.0 section 4 requires attribution to travel with redistribution.
  // Dropping either of these in a copy edit is a licence violation, so it
  // fails here rather than shipping.
  assertEqual(VOICE_ENGINE_CREDITS.length, 2, 'the model and the engine, both credited');
  for (const credit of VOICE_ENGINE_CREDITS) {
    assertEqual(credit.licence, 'Apache License 2.0', `${credit.title} names its licence`);
    assert(credit.url.startsWith('https://'), `${credit.title} links to its source over https`);
    assert(credit.title.length > 0, 'every credit has a heading');
    assert(credit.detail.length > 0, 'every credit says which build it is');
  }
});

await runCase('the model is pinned to the exact revision that was tested', () => {
  const model = VOICE_ENGINE_CREDITS[0];
  assert(model.detail.includes('alphacep/vosk-model-streaming-ru'), 'the model is named');
  assert(model.detail.includes('83bbf6f'), 'the exact revision is named');
  assert(model.detail.includes('Large INT8'), 'the exact variant is named');
  assertEqual(model.url, 'https://huggingface.co/alphacep/vosk-model-streaming-ru');
});

await runCase('the engine is pinned to the exact version that was vendored', () => {
  const engine = VOICE_ENGINE_CREDITS[1];
  assert(engine.detail.includes('k2-fsa/sherpa-onnx'), 'the engine is named');
  assert(engine.detail.includes('v1.12.20'), 'the exact version is named');
  assertEqual(engine.url, 'https://github.com/k2-fsa/sherpa-onnx');
});

await runCase('the licence text is reachable and the promise is stated', () => {
  assertEqual(VOICE_ENGINE_LICENCE_URL, 'https://www.apache.org/licenses/LICENSE-2.0');
  assert(
    VOICE_ENGINE_LICENCE_NOTE.includes('Apache License 2.0'),
    'the note names the licence in full',
  );
  assert(
    VOICE_ENGINE_LICENCE_NOTE.includes('apache.org/licenses/LICENSE-2.0'),
    'the note points at the full text, as Apache 2.0 asks',
  );
  assert(VOICE_ENGINE_NOTICE_TITLE.length > 0, 'the section has a heading');
  assert(
    VOICE_ENGINE_NOTICE_BODY.includes('на твоём устройстве'),
    'the notice repeats the on-device promise where people will actually read it',
  );
});

console.log('voiceEngineNotice.cases.test.ts — all passed');
