import { createDeferredVoiceDisposer } from './voiceDictationLifecycle';

function assertEqual(actual: number, expected: number, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

let nextId = 0;
const pending = new Map<number, () => void>();
let disposeCalls = 0;
const lifecycle = createDeferredVoiceDisposer({
  dispose: () => { disposeCalls += 1; },
  schedule: (callback) => {
    nextId += 1;
    pending.set(nextId, callback);
    return nextId;
  },
  cancel: (id) => { pending.delete(id); },
});

lifecycle.mount();
lifecycle.unmount();
lifecycle.mount();
for (const callback of pending.values()) callback();
assertEqual(disposeCalls, 0, 'Strict Mode remount cancels the simulated unmount disposal');

lifecycle.unmount();
for (const callback of [...pending.values()]) callback();
assertEqual(disposeCalls, 1, 'a real unmount disposes after the deferred boundary');

lifecycle.unmount();
for (const callback of [...pending.values()]) callback();
assertEqual(disposeCalls, 1, 'disposal remains idempotent');

console.log('voiceDictationLifecycle.cases.test.ts — all passed');
