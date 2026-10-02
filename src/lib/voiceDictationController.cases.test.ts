import type {
  VoiceDictationAdapter,
  VoiceDictationErrorCode,
  VoiceDictationSession,
  VoiceRecognitionEvent,
} from './voiceDictationContract';
import { createVoiceDictationController } from './voiceDictationController';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert(Object.is(actual, expected), `${message}: ${String(actual)} !== ${String(expected)}`);
}

function fakeClock() {
  let now = 1_000;
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  return {
    value: {
      now: () => now,
      setInterval(callback: () => void) {
        const id = nextId;
        nextId += 1;
        callbacks.set(id, callback);
        return id;
      },
      clearInterval(id: number) { callbacks.delete(id); },
    },
    advance(ms: number) {
      now += ms;
      for (const callback of callbacks.values()) callback();
    },
    get activeTimers() { return callbacks.size; },
  };
}

type AdapterCallbacks = Parameters<VoiceDictationAdapter['start']>[0];

function fakeAdapter(options: { supported?: boolean; deferred?: boolean } = {}) {
  const callbacks: AdapterCallbacks[] = [];
  const sessions: Array<VoiceDictationSession & { stopCalls: number; disposeCalls: number }> = [];
  const resolvers: Array<(session: VoiceDictationSession) => void> = [];
  let startCalls = 0;
  const value: VoiceDictationAdapter = {
    supported: options.supported !== false,
    start(nextCallbacks) {
      startCalls += 1;
      callbacks.push(nextCallbacks);
      const session = {
        stopCalls: 0,
        disposeCalls: 0,
        stop() { this.stopCalls += 1; },
        dispose() { this.disposeCalls += 1; },
      };
      sessions.push(session);
      if (!options.deferred) return Promise.resolve(session);
      return new Promise((resolve) => resolvers.push(resolve));
    },
  };
  return {
    value,
    callbacks,
    sessions,
    resolvers,
    get startCalls() { return startCalls; },
    emitStart(index = 0) { callbacks[index].onStart(); },
    emitTranscript(event: VoiceRecognitionEvent, index = 0) { callbacks[index].onTranscript(event); },
    emitLevel(level: number, index = 0) { callbacks[index].onLevel(level); },
    emitError(code: VoiceDictationErrorCode, index = 0) { callbacks[index].onError(code); },
    emitEnd(index = 0) { callbacks[index].onEnd(); },
  };
}

async function runCase(name: string, callback: () => void | Promise<void>): Promise<void> {
  await callback();
  console.log(`PASS: ${name}`);
}

await runCase('unsupported adapter returns a safe error without starting', async () => {
  const adapter = fakeAdapter({ supported: false });
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: fakeClock().value });
  await controller.start('Черновик');
  equal(adapter.startCalls, 0, 'adapter is untouched');
  equal(controller.getSnapshot().phase, 'error', 'phase');
  equal(controller.getSnapshot().errorCode, 'unsupported', 'safe code');
  equal(controller.getSnapshot().previewDraft, 'Черновик', 'draft preserved');
});

await runCase('rapid starts create one session and preview preserves the base draft', async () => {
  const adapter = fakeAdapter({ deferred: true });
  const clock = fakeClock();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: clock.value });
  const first = controller.start('Мне важно');
  const second = controller.start('не использовать');
  equal(adapter.startCalls, 1, 'one adapter start');
  adapter.emitStart();
  adapter.emitTranscript({ finalText: 'сказать', interimText: ' это' });
  equal(controller.getSnapshot().previewDraft, 'Мне важно сказать это', 'preview draft');
  adapter.resolvers[0](adapter.sessions[0]);
  await Promise.all([first, second]);
});

await runCase('timer and level update only while listening', async () => {
  const adapter = fakeAdapter();
  const clock = fakeClock();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: clock.value });
  await controller.start('');
  adapter.emitStart();
  clock.advance(1_250);
  adapter.emitLevel(0.6);
  equal(controller.getSnapshot().elapsedMs, 1_250, 'elapsed time');
  equal(controller.getSnapshot().level, 0.6, 'voice level');
  equal(clock.activeTimers, 1, 'one timer');
});

await runCase('manual stop is idempotent and natural end preserves text', async () => {
  const adapter = fakeAdapter();
  const clock = fakeClock();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: clock.value });
  await controller.start('Было');
  adapter.emitStart();
  adapter.emitTranscript({ finalText: 'стало', interimText: '' });
  controller.stop();
  controller.stop();
  equal(adapter.sessions[0].stopCalls, 1, 'one stop');
  equal(controller.getSnapshot().phase, 'stopping', 'stopping phase');
  adapter.emitEnd();
  equal(controller.getSnapshot().phase, 'idle', 'idle after end');
  equal(controller.getSnapshot().previewDraft, 'Было стало', 'text survives');
  equal(clock.activeTimers, 0, 'timer released');
});

await runCase('stop during starting is applied when the session resolves', async () => {
  const adapter = fakeAdapter({ deferred: true });
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: fakeClock().value });
  const start = controller.start('');
  controller.stop();
  adapter.resolvers[0](adapter.sessions[0]);
  await start;
  equal(adapter.sessions[0].stopCalls, 1, 'deferred session stopped');
});

await runCase('safe error preserves transcript and releases the session', async () => {
  const adapter = fakeAdapter();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: fakeClock().value });
  await controller.start('Основа');
  adapter.emitStart();
  adapter.emitTranscript({ finalText: 'текст', interimText: '' });
  adapter.emitError('permission-denied');
  equal(controller.getSnapshot().phase, 'error', 'error phase');
  equal(controller.getSnapshot().errorCode, 'permission-denied', 'safe error');
  equal(controller.getSnapshot().previewDraft, 'Основа текст', 'text preserved');
  equal(adapter.sessions[0].disposeCalls, 1, 'session disposed');
});

await runCase('old session events cannot change a newer session', async () => {
  const adapter = fakeAdapter();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: fakeClock().value });
  await controller.start('Первый');
  controller.stop();
  adapter.emitEnd(0);
  await controller.start('Второй');
  adapter.emitTranscript({ finalText: 'старый', interimText: '' }, 0);
  equal(controller.getSnapshot().previewDraft, 'Второй', 'stale event ignored');
  adapter.emitTranscript({ finalText: 'новый', interimText: '' }, 1);
  equal(controller.getSnapshot().previewDraft, 'Второй новый', 'current event accepted');
});

await runCase('subscription and dispose are deterministic', async () => {
  const adapter = fakeAdapter();
  const clock = fakeClock();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: clock.value });
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications += 1; });
  await controller.start('');
  adapter.emitStart();
  assert(notifications >= 2, 'subscriber notified');
  unsubscribe();
  const beforeDispose = notifications;
  controller.dispose();
  controller.dispose();
  equal(adapter.sessions[0].disposeCalls, 1, 'session disposed once');
  equal(clock.activeTimers, 0, 'timer removed');
  equal(notifications, beforeDispose, 'unsubscribed listener remains quiet');
});

console.log('voiceDictationController.cases.test.ts — all passed');
