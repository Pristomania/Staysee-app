import {
  createVoiceRecognitionQueue,
  VOICE_QUEUE_CAPACITY,
  type VoiceAudioChunk,
} from './voiceRecognitionQueue';

function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message = 'values must be equal'): void {
  assert(Object.is(actual, expected), `${message}: ${String(actual)} !== ${String(expected)}`);
}

function assertDeepEqual(actual: unknown, expected: unknown, message = 'values must be deeply equal'): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

async function runCase(name: string, callback: () => void | Promise<void>): Promise<void> {
  await callback();
  console.log(`PASS: ${name}`);
}

function chunk(marker: number): VoiceAudioChunk {
  return { sampleRate: 48_000, samples: new Float32Array([marker]) };
}

function marker(value: VoiceAudioChunk | null): number {
  assert(value !== null, 'a chunk was expected');
  return value.samples[0];
}

await runCase('holds chunks in arrival order up to capacity', () => {
  const queue = createVoiceRecognitionQueue(3);
  queue.push(chunk(1));
  queue.push(chunk(2));
  queue.push(chunk(3));
  assertEqual(queue.size, 3);
  assertEqual(queue.droppedChunks, 0);
  assertEqual(marker(queue.shift()), 1);
  assertEqual(marker(queue.shift()), 2);
  assertEqual(marker(queue.shift()), 3);
  assertEqual(queue.shift(), null, 'an empty queue yields null');
});

await runCase('drops the oldest chunk when full so the newest speech survives', () => {
  const queue = createVoiceRecognitionQueue(3);
  queue.push(chunk(1));
  queue.push(chunk(2));
  queue.push(chunk(3));
  queue.push(chunk(4));
  assertEqual(queue.size, 3, 'the cap holds');
  assertEqual(queue.droppedChunks, 1, 'exactly one chunk was dropped');
  assertDeepEqual(
    [marker(queue.shift()), marker(queue.shift()), marker(queue.shift())],
    [2, 3, 4],
    'the three most recent chunks are what remain',
  );
});

await runCase('a ten-minute flood never grows past capacity', () => {
  // Review Focus 3: on a slow device the decoder falls behind for the whole
  // recording. 10 minutes of 4096-frame blocks at 48 kHz is ~7030 chunks;
  // memory must stay flat the entire time.
  const queue = createVoiceRecognitionQueue();
  for (let index = 0; index < 7_030; index += 1) {
    queue.push(chunk(index));
    assert(queue.size <= VOICE_QUEUE_CAPACITY, 'the queue never exceeds its cap');
  }
  assertEqual(queue.size, VOICE_QUEUE_CAPACITY);
  assertEqual(queue.droppedChunks, 7_030 - VOICE_QUEUE_CAPACITY, 'every drop is counted');
  assertEqual(marker(queue.shift()), 7_030 - VOICE_QUEUE_CAPACITY, 'the survivors are the newest');
});

await runCase('clear empties the queue without rewriting the drop history', () => {
  const queue = createVoiceRecognitionQueue(2);
  queue.push(chunk(1));
  queue.push(chunk(2));
  queue.push(chunk(3));
  assertEqual(queue.droppedChunks, 1);
  queue.clear();
  assertEqual(queue.size, 0);
  assertEqual(queue.shift(), null);
  assertEqual(queue.droppedChunks, 1, 'clearing a session does not erase that audio was dropped');
});

await runCase('capacity below one is refused rather than silently dropping everything', () => {
  let thrown = false;
  try { createVoiceRecognitionQueue(0); } catch { thrown = true; }
  assert(thrown, 'a zero-capacity queue would discard every chunk forever');
});

console.log('voiceRecognitionQueue.cases.test.ts — all passed');
