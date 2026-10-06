# Local Voice Recognition Engine (Part 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the on-device (in-browser, sherpa-onnx WASM) Russian speech recognition engine behind StaySee's existing `VoiceDictationAdapter` contract — worker, audio capture pipeline, model download/caching, and the orchestrating adapter — with no chat-UI changes.

**Architecture:** Push every decision into plain, dependency-injected TypeScript modules (`voiceRecognitionSession`, `voiceRecognitionQueue`, `voiceModelCache`) that run under `tsx` with fakes, exactly as `browserVoiceDictation.ts` already pushes logic into `voiceDictationContract.ts`. Two files touch real browser APIs that have no Node equivalent and are therefore deliberately mechanical: `voiceRecognitionWorker.ts` (module Worker: loads the WASM engine, owns the recognizer) and `voiceCaptureProcessor.js` (AudioWorkletProcessor: posts Float32 PCM blocks). `localVoiceDictation.ts` orchestrates them through an injected `LocalVoicePlatform`, mirroring `createBrowserVoiceDictationAdapter(platform)` one-for-one.

**Tech Stack:** TypeScript 5.5 (strict, `isolatedModules`, `noUnusedLocals`), Vite 5.4.8, sherpa-onnx v1.12.20 WASM + `alphacep/vosk-model-streaming-ru` rev `83bbf6f` Large INT8, Cache Storage API, module Web Worker, AudioWorklet, Node test runner through `tsx` (`npm run test:offline`). No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-local-voice-dictation-design.md` (contract basis: `docs/superpowers/specs/2026-10-02-voice-dictation-design.md`)

## Global Constraints

- Recognition language is Russian only; no language selection in this version.
- Audio never leaves the device over the network, at any stage, in any form.
- Recognizer config is exactly this and must not change without an A/B comparison on identical audio: `featConfig: { sampleRate: 16000, featureDim: 80 }`, `modelType: 'zipformer2'`, `provider: 'cpu'`, `numThreads: 1`, `decodingMethod: 'modified_beam_search'`, `maxActivePaths: 10`, `enableEndpoint: 0`.
- Model files are already uploaded and live; use exactly these URLs:
  `https://staysee.ru/voice-model/83bbf6f-large-int8/sherpa-onnx-wasm-main-asr.data` (71,694,239 bytes)
  `https://staysee.ru/voice-model/83bbf6f-large-int8/sherpa-onnx-wasm-main-asr.wasm` (11,545,586 bytes)
  Total 83,239,825 bytes. Revision string `83bbf6f-large-int8` lives in exactly one constant.
- Maximum single recording: 600,000 ms (10 minutes), hard stop.
- Nothing downloads without the user having already acted (Part 2 owns the consent screen; Part 1 downloads only inside `adapter.start()`).
- The voice package must be deletable independently of account, conversations and other site data.
- Raw engine errors, diagnostics and device names must never reach `onError`/the UI.
- `browserVoiceDictation.ts`, `browserVoiceDictation.cases.test.ts`, `voiceDictationLifecycle.ts`, `useVoiceDictation.ts`, `ChatScreen.tsx` are NOT modified in this plan. Existing copy strings for `recognition-failed`/`connection-blocked` are NOT changed (Part 2 owns that — see "Handoff to Part 2").
- No new npm dependency, no backend endpoint, no DB migration, no analytics event.
- All new `.cases.test.ts` files use the in-file harness (`assert`/`assertEqual`/`assertDeepEqual`/`runCase`/`console.log('PASS: …')`) and are run by `scripts/run-offline-tests.mjs`; never import a test framework.
- `dispose()` must be synchronous and idempotent (it is called from `createDeferredVoiceDisposer`), and must silence all later events.

## Review Focus

1. **A laptop that sleeps mid-download.** Timers in a suspended/backgrounded tab fire late, so a naive stall deadline kills a download that is still alive; the stall watchdog must compare real elapsed time since the last received byte and re-arm instead of failing. → test in Task 5.
2. **A second tab starting dictation while the first is still `preparing`.** Both download ~83 MB and both write the same two cache entries; the second write must overwrite cleanly rather than throw, and a single adapter must never create two workers. → tests in Task 5 and Task 9.
3. **A 10-minute recording on a slow device where chunks outpace the decoder.** The worker queue must stay pinned at its cap forever instead of growing, and the dropped chunk must be the oldest so the partial text the user is watching keeps up with what they are saying. → test in Task 4.
4. **A future model revision with a typo in the path or a stale byte count.** URLs and sizes must be pinned by exact-string/exact-length assertions, and a 404 or a short body must fail loudly as a prepare error rather than handing truncated bytes to the WASM engine. → tests in Task 5.
5. **Cache Storage entirely unavailable** (insecure context, hardened privacy mode). Preparation must still succeed by downloading into memory and reporting `fromCache: false`, and `deletePackage` must be a harmless `false` rather than a crash. → tests in Task 5.

## File Structure

- Modify `src/lib/voiceDictationContract.ts` — `preparing` phase, `VoiceDictationPrepareProgress`, `prepareProgress` snapshot field, `onPrepareProgress` adapter callback, `prepare-failed` code + Russian copy, `voiceLevelFromSamples`.
- Modify `src/lib/voiceDictationContract.cases.test.ts` — cases for the above.
- Modify `src/lib/voiceDictationController.ts` — carry the `preparing` phase without changing browser-adapter behavior.
- Modify `src/lib/voiceDictationController.cases.test.ts` — preparing/progress/cancel cases.
- Modify `src/lib/chatVoiceIntegration.ts` + its test — `preparing` counts as an active session.
- Create `src/lib/voiceRecognitionSession.ts` + `.cases.test.ts` — pure port of the prototype's `feed`/`finish`, including the sample-rate-on-finish fix.
- Create `src/lib/voiceRecognitionQueue.ts` + `.cases.test.ts` — bounded drop-oldest audio queue.
- Create `src/lib/voiceModelCache.ts` + `.cases.test.ts` — download with progress, Cache Storage read/write/delete/purge, quota and stall handling, cancellation.
- Create `public/voice-engine/sherpa-onnx-asr.js` (vendored, 41,274 B), `public/voice-engine/sherpa-onnx-wasm-main-asr.js` (vendored, 92,139 B), `public/voice-engine/ORIGIN.md`.
- Modify `vite.config.ts` — `worker: { format: 'es' }`.
- Modify `scripts/verify-prod-bundle.mjs` — engine files + worklet + worker present in `dist`.
- Create `src/lib/voiceCaptureProcessor.js` — AudioWorkletProcessor (no unit test; see Task 7).
- Create `src/lib/voiceRecognitionWorker.ts` — module Worker entry + message protocol types (no unit test; see Task 8).
- Create `src/lib/localVoiceDictation.ts` + `.cases.test.ts` — `createLocalVoiceDictationAdapter(platform)`.

## Verified environment facts (do not re-derive)

- `scripts/run-offline-tests.mjs` runs every `src/**/*.cases.test.ts` with `node tsx --test`. There is **no** jsdom/Vitest/Jest, and no Worker, WASM or AudioWorklet test environment. `package.json` has no testing library at all. Hence Tasks 7 and 8 carry build-level verification instead of unit tests.
- ESLint (`eslint.config.js`) lints only `**/*.{ts,tsx}`, so `voiceCaptureProcessor.js` is not linted. `tsconfig.app.json` has no `allowJs`, so it is not type-checked either. No config change needed for it.
- `src/vite-env.d.ts` already has `/// <reference types="vite/client" />`.
- Vite 5.4.8 `vite:worker-import-meta-url` computes the worker type from the literal options object, and in **dev** it serves the worker file *without bundling*. A classic worker therefore keeps its ES `import` statements and is a dev-time `SyntaxError`. The worker **must** be `{ type: 'module' }` with `worker: { format: 'es' }`. Module workers have no `importScripts`, so the two vendored classic engine scripts are loaded with indirect `eval` (which, unlike `new Function`, runs in global scope so the engine's top-level `var`/`function` declarations land on `self` exactly as `importScripts` would). `createOnlineRecognizer` is a top-level `function` declaration in `sherpa-onnx-asr.js`, so it is reachable this way; `OnlineRecognizer` is a `class` and would not be, which is why the factory function is used instead of the prototype's `new OnlineRecognizer(...)`.
- There is **no** Content-Security-Policy anywhere in `deploy/`, `index.html` or `vercel.json`, so indirect `eval` and WASM compilation are not blocked.
- `vite:asset-import-meta-url` in 5.4.8 calls `fileToUrl` for any extension, so `new URL('./voiceCaptureProcessor.js', import.meta.url)` emits the file as a verbatim asset in build and serves it as `text/javascript` in dev. Confirmed in `node_modules/vite/dist/node/chunks/dep-CDnG8rE7.js`.
- The Emscripten glue honours `Module.wasmBinary` (grep-confirmed: `if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"]` and `getBinarySync` returns it), so the cached `.wasm` bytes are supplied directly — no second network fetch, which is how "cache both files" is actually achieved.
- There is no `public/` directory yet; Vite's default `publicDir: 'public'` picks it up with no config change.
- `tokens.txt`, `encoder.onnx`, `decoder.onnx`, `joiner.onnx` live **inside** the `.data` package's virtual FS at `/`; they are not separate files to host.

## Shared test preamble

Every new `.cases.test.ts` file in this plan starts with exactly this block (the repo has no shared helper module; `browserVoiceDictation.cases.test.ts` defines its own copy too). Where a task's test code below is shown, this preamble is assumed to be above it and must be typed in verbatim:

```ts
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
```

## TDD rhythm for every task

Each task follows the same five steps; they are not repeated per task to keep this document readable, but each one must be performed:

1. Write the failing test code shown in the task.
2. Run the task's test command; confirm it fails for the stated reason.
3. Write the implementation code shown in the task.
4. Re-run the test command; confirm PASS, then run `npm run test:offline` to confirm nothing else broke.
5. Commit with the message given in the task.

---

### Task 1: Extend the dictation contract with a preparation phase

**Files:**
- Modify: `src/lib/voiceDictationContract.ts`
- Test: `src/lib/voiceDictationContract.cases.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VoiceDictationPhase` (now includes `'preparing'`), `VoiceDictationErrorCode` (now includes `'prepare-failed'`), `interface VoiceDictationPrepareProgress { loadedBytes: number; totalBytes: number }`, `VoiceDictationSnapshot.prepareProgress: VoiceDictationPrepareProgress | null`, `VoiceDictationAdapter.start` callbacks gain `onPrepareProgress(progress: VoiceDictationPrepareProgress | null): void`, `voiceLevelFromSamples(samples: ArrayLike<number>): number`.

**Test (append before the final `console.log` line of the existing file):**

```ts
assert(
  voiceDictationErrorCopy('prepare-failed').includes('место'),
  'prepare failure names the disk-space cause',
);
assert(
  voiceDictationErrorCopy('prepare-failed').includes('интернет'),
  'prepare failure names the network cause',
);
assert(
  !voiceDictationErrorCopy('prepare-failed').includes('Microsoft Edge'),
  'on-device preparation never advises another browser',
);
assert(
  !voiceDictationErrorCopy('prepare-failed').includes('QuotaExceededError'),
  'raw storage errors never leak',
);
assert(voiceLevelFromSamples([]) === 0, 'an empty block is silent');
assert(voiceLevelFromSamples([0, 0, 0, 0]) === 0, 'digital silence is silent');
assert(voiceLevelFromSamples([1, -1, 1, -1]) === 1, 'full scale is one');
assert(voiceLevelFromSamples([Number.NaN, 0, 0, 0]) === 0, 'a NaN sample is treated as silence');
assert(voiceLevelFromSamples([4, -4]) === 1, 'an out-of-range block is clamped, never above one');
```

Add `voiceLevelFromSamples` to the file's existing import list.

**Implementation — the complete new `src/lib/voiceDictationContract.ts`:**

```ts
export type VoiceDictationPhase =
  | 'idle'
  | 'starting'
  | 'preparing'
  | 'listening'
  | 'stopping'
  | 'error';

export type VoiceDictationErrorCode =
  | 'permission-denied'
  | 'unsupported'
  | 'no-speech'
  | 'recognition-failed'
  | 'connection-blocked'
  | 'prepare-failed';

export interface VoiceRecognitionEvent {
  finalText: string;
  interimText: string;
}

/** Byte progress of the one-time on-device voice package download. */
export interface VoiceDictationPrepareProgress {
  loadedBytes: number;
  totalBytes: number;
}

export interface VoiceDictationSnapshot {
  supported: boolean;
  phase: VoiceDictationPhase;
  previewDraft: string;
  finalText: string;
  interimText: string;
  elapsedMs: number;
  level: number;
  /**
   * Filled only while `phase === 'preparing'`. `null` during preparation
   * means "working, but with no byte progress to show" -- the engine is
   * opening an already-downloaded model, which has no progress of its own.
   */
  prepareProgress: VoiceDictationPrepareProgress | null;
  errorCode: VoiceDictationErrorCode | null;
}

export interface VoiceDictationSession {
  stop(): void;
  dispose(): void;
}

export interface VoiceDictationAdapter {
  readonly supported: boolean;
  start(callbacks: {
    onStart(): void;
    onPrepareProgress(progress: VoiceDictationPrepareProgress | null): void;
    onTranscript(event: VoiceRecognitionEvent): void;
    onLevel(level: number): void;
    onError(code: VoiceDictationErrorCode): void;
    onEnd(): void;
  }): Promise<VoiceDictationSession>;
}

export function appendDictationToDraft(draft: string, speech: string): string {
  const left = draft.trimEnd();
  const right = speech.trim();
  if (!right) return left;
  return left ? `${left} ${right}` : right;
}

export function formatDictationDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function normalizeVoiceLevel(level: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
}

/**
 * RMS level of one captured PCM block. Lives beside `normalizeVoiceLevel`
 * because the on-device adapter measures amplitude from the very same
 * Float32 block it hands to the recognizer -- there is no second
 * `getUserMedia()` and no AnalyserNode.
 */
export function voiceLevelFromSamples(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const normalized = Number.isFinite(sample) ? sample : 0;
    sumSquares += normalized * normalized;
  }
  return normalizeVoiceLevel(Math.sqrt(sumSquares / samples.length));
}

export function voiceDictationErrorCopy(code: VoiceDictationErrorCode): string {
  if (code === 'permission-denied') {
    return 'Разреши доступ к микрофону в настройках браузера';
  }
  if (code === 'unsupported') {
    return 'В этом браузере голосовой ввод пока недоступен';
  }
  if (code === 'no-speech') {
    return 'Не удалось расслышать. Попробуй ещё раз';
  }
  if (code === 'prepare-failed') {
    // One code, one string, as the design requires -- but the string names
    // the two causes a person can actually act on, the same way the
    // `connection-blocked` copy above names its likely causes.
    return 'Не удалось подготовить голосовой ввод. Проверь, есть ли свободное место на устройстве и стабильный интернет, и попробуй ещё раз';
  }
  if (code === 'connection-blocked') {
    return 'Браузер не может подключиться к сервису распознавания речи. Проверь блокировщики рекламы/приватности и VPN, или попробуй Microsoft Edge';
  }
  return 'Не удалось распознать голос в этом браузере. Попробуй Microsoft Edge';
}
```

**Run:** `npx tsx src/lib/voiceDictationContract.cases.test.ts`
**Expected before implementation:** FAIL — `voiceLevelFromSamples` is not exported.
**Commit:** `feat(voice): add preparing phase and prepare-failed code to the dictation contract`

---

### Task 2: Carry the preparing phase through the controller and composer decisions

**Files:**
- Modify: `src/lib/voiceDictationController.ts`
- Modify: `src/lib/chatVoiceIntegration.ts:10-12`
- Test: `src/lib/voiceDictationController.cases.test.ts`, `src/lib/chatVoiceIntegration.cases.test.ts`

**Interfaces:**
- Consumes: Task 1's `VoiceDictationPrepareProgress`, `onPrepareProgress`, `'preparing'`, `'prepare-failed'`.
- Produces: unchanged `VoiceDictationController` shape; snapshots now carry `prepareProgress`.

**Test — in `voiceDictationController.cases.test.ts`, add `emitPrepareProgress` to `fakeAdapter`'s returned object:**

```ts
    emitPrepareProgress(progress: VoiceDictationPrepareProgress | null, index = 0) {
      callbacks[index].onPrepareProgress(progress);
    },
```

Add `VoiceDictationPrepareProgress` to that file's `import type` list, then append these cases before the final `console.log`:

```ts
await runCase('reports preparing with byte progress and clears it when listening starts', async () => {
  const adapter = fakeAdapter();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: fakeClock().value });
  await controller.start('Черновик');
  adapter.emitPrepareProgress({ loadedBytes: 0, totalBytes: 83_239_825 });
  equal(controller.getSnapshot().phase, 'preparing', 'phase');
  adapter.emitPrepareProgress({ loadedBytes: 1_000, totalBytes: 83_239_825 });
  equal(controller.getSnapshot().prepareProgress?.loadedBytes, 1_000, 'progress updates');
  adapter.emitStart();
  equal(controller.getSnapshot().phase, 'listening', 'preparing hands over to listening');
  equal(controller.getSnapshot().prepareProgress, null, 'progress is cleared once listening');
  equal(controller.getSnapshot().previewDraft, 'Черновик', 'the draft survives preparation');
  controller.dispose();
});

await runCase('indeterminate preparation is a preparing phase without a byte bar', async () => {
  const adapter = fakeAdapter();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: fakeClock().value });
  await controller.start('');
  adapter.emitPrepareProgress(null);
  equal(controller.getSnapshot().phase, 'preparing', 'phase');
  equal(controller.getSnapshot().prepareProgress, null, 'no bar is claimed');
  controller.dispose();
});

await runCase('a second start while preparing reuses the in-flight session', async () => {
  // Review Focus 2: a person pressing the mic again during an 83 MB
  // download must not start a second download in the same tab.
  const adapter = fakeAdapter();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: fakeClock().value });
  await controller.start('');
  adapter.emitPrepareProgress({ loadedBytes: 10, totalBytes: 83_239_825 });
  await controller.start('');
  equal(adapter.startCalls, 1, 'only one adapter session exists');
  controller.dispose();
});

await runCase('stop during preparing cancels the session', async () => {
  const adapter = fakeAdapter();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: fakeClock().value });
  await controller.start('');
  adapter.emitPrepareProgress({ loadedBytes: 10, totalBytes: 83_239_825 });
  controller.stop();
  equal(controller.getSnapshot().phase, 'stopping', 'stopping phase');
  equal(adapter.sessions[0].stopCalls, 1, 'the adapter was asked to stop');
  adapter.emitEnd();
  equal(controller.getSnapshot().phase, 'idle', 'back to idle');
  equal(controller.getSnapshot().prepareProgress, null, 'progress is cleared');
  controller.dispose();
});

await runCase('a prepare failure becomes an error phase and keeps the draft', async () => {
  const adapter = fakeAdapter();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: fakeClock().value });
  await controller.start('Мой текст');
  adapter.emitPrepareProgress({ loadedBytes: 10, totalBytes: 83_239_825 });
  adapter.emitError('prepare-failed');
  equal(controller.getSnapshot().phase, 'error', 'error phase');
  equal(controller.getSnapshot().errorCode, 'prepare-failed', 'safe code');
  equal(controller.getSnapshot().prepareProgress, null, 'progress is cleared');
  equal(controller.getSnapshot().previewDraft, 'Мой текст', 'draft preserved');
  controller.dispose();
});

await runCase('prepare progress from a superseded session is ignored', async () => {
  const adapter = fakeAdapter();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: fakeClock().value });
  await controller.start('');
  adapter.emitError('prepare-failed');
  adapter.emitPrepareProgress({ loadedBytes: 99, totalBytes: 83_239_825 });
  equal(controller.getSnapshot().phase, 'error', 'a stale progress event cannot resurrect preparing');
  equal(controller.getSnapshot().prepareProgress, null, 'and cannot resurrect the bar');
  controller.dispose();
});
```

**Test — append to `chatVoiceIntegration.cases.test.ts` (match its existing bare-`assert` style):**

```ts
assert(shouldStopVoiceDictation('preparing'), 'a downloading session is an active session to stop');
assert(
  !canStartVoiceDictation({ sending: false, phase: 'preparing' }),
  'the mic cannot be pressed again while the package downloads',
);
```

**Implementation — `src/lib/chatVoiceIntegration.ts`, replace `shouldStopVoiceDictation`:**

```ts
export function shouldStopVoiceDictation(phase: VoiceDictationPhase): boolean {
  return (
    phase === 'starting'
    || phase === 'preparing'
    || phase === 'listening'
    || phase === 'stopping'
  );
}
```

**Implementation — `src/lib/voiceDictationController.ts`, six edits:**

1. Add `type VoiceDictationPrepareProgress,` to the existing `import` from `./voiceDictationContract`.
2. Initial snapshot — add `prepareProgress: null,` after `level: 0,`.
3. `finish` — replace its `publish` call with:

```ts
    publish({ phase: 'idle', level: 0, interimText: '', prepareProgress: null, errorCode: null });
```

4. `fail` — replace its `publish` call with:

```ts
    publish({ phase: 'error', level: 0, interimText: '', prepareProgress: null, errorCode });
```

5. `start` — replace the re-entrancy guard and the opening `publish`:

```ts
      if (
        snapshot.phase === 'starting'
        || snapshot.phase === 'preparing'
        || snapshot.phase === 'listening'
        || snapshot.phase === 'stopping'
      ) {
        return startPromise ?? Promise.resolve();
      }
```

```ts
      publish({
        phase: 'starting',
        previewDraft: baseDraft,
        finalText: '',
        interimText: '',
        elapsedMs: 0,
        level: 0,
        prepareProgress: null,
        errorCode: null,
      });
```

   and inside the `adapter.start({ … })` callbacks object, replace `onStart` and add `onPrepareProgress` directly after it:

```ts
        onStart() {
          if (disposed || token !== sessionToken) return;
          // The on-device adapter reaches `listening` from `preparing`;
          // the browser adapter still reaches it from `starting`.
          if (snapshot.phase !== 'starting' && snapshot.phase !== 'preparing') return;
          startedAt = clock.now();
          publish({ phase: 'listening', prepareProgress: null });
          timer = clock.setInterval(() => {
            if (token === sessionToken) publish({ elapsedMs: clock.now() - startedAt });
          }, 250);
        },
        onPrepareProgress(progress: VoiceDictationPrepareProgress | null) {
          if (disposed || token !== sessionToken) return;
          if (snapshot.phase !== 'starting' && snapshot.phase !== 'preparing') return;
          publish({ phase: 'preparing', prepareProgress: progress });
        },
```

6. `stop` — replace its guard:

```ts
      if (
        disposed
        || (snapshot.phase !== 'starting'
          && snapshot.phase !== 'preparing'
          && snapshot.phase !== 'listening')
      ) {
        return;
      }
```

**Run:** `npx tsx src/lib/voiceDictationController.cases.test.ts && npx tsx src/lib/chatVoiceIntegration.cases.test.ts`
**Expected before implementation:** FAIL — `emitPrepareProgress` has no `onPrepareProgress` to call / `shouldStopVoiceDictation('preparing')` is false.
**Commit:** `feat(voice): carry the preparing phase through the dictation controller`

---

### Task 3: Port the recognizer session, fixing the final-block sample rate

**Files:**
- Create: `src/lib/voiceRecognitionSession.ts`
- Test: `src/lib/voiceRecognitionSession.cases.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VoiceRecognizerStreamLike`, `VoiceRecognizerLike`, `VoiceRecognitionSession`, `FALLBACK_SAMPLE_RATE`, `createVoiceRecognitionSession(recognizer: VoiceRecognizerLike): VoiceRecognitionSession`.

**Test — `src/lib/voiceRecognitionSession.cases.test.ts` (shared preamble above, then):**

```ts
import {
  createVoiceRecognitionSession,
  FALLBACK_SAMPLE_RATE,
  type VoiceRecognizerLike,
  type VoiceRecognizerStreamLike,
} from './voiceRecognitionSession';

function createFakeRecognizer(options: { readyPerFeed?: number } = {}) {
  const readyPerFeed = options.readyPerFeed ?? 1;
  const accepted: Array<{ sampleRate: number; length: number }> = [];
  let readyLeft = 0;
  let decodeCalls = 0;
  let inputFinishedCalls = 0;
  let freeCalls = 0;
  let resultText = '';

  const stream: VoiceRecognizerStreamLike = {
    acceptWaveform(sampleRate, samples) {
      accepted.push({ sampleRate, length: samples.length });
      readyLeft += readyPerFeed;
    },
    inputFinished() { inputFinishedCalls += 1; },
    free() { freeCalls += 1; },
  };

  const value: VoiceRecognizerLike = {
    createStream: () => stream,
    isReady: () => readyLeft > 0,
    decode() { readyLeft -= 1; decodeCalls += 1; },
    getResult: () => ({ text: resultText }),
  };

  return {
    value,
    accepted,
    get decodeCalls() { return decodeCalls; },
    get inputFinishedCalls() { return inputFinishedCalls; },
    get freeCalls() { return freeCalls; },
    setResult(text: string) { resultText = text; },
  };
}

await runCase('feed decodes until the recognizer is no longer ready and returns the text', () => {
  const recognizer = createFakeRecognizer({ readyPerFeed: 3 });
  recognizer.setResult('привет');
  const session = createVoiceRecognitionSession(recognizer.value);
  assertEqual(session.feed(48_000, new Float32Array(4096)), 'привет');
  assertEqual(recognizer.decodeCalls, 3, 'drained every ready frame');
  assertDeepEqual(recognizer.accepted, [{ sampleRate: 48_000, length: 4096 }]);
});

await runCase('finish pads the final block at the rate of the last fed audio', () => {
  // The prototype hardcoded 16000 here. On a 48 kHz AudioContext that
  // padded a third of a second instead of a second of silence, and the
  // tail of the last phrase was lost or garbled.
  const recognizer = createFakeRecognizer();
  const session = createVoiceRecognitionSession(recognizer.value);
  session.feed(48_000, new Float32Array(4096));
  session.finish();
  const last = recognizer.accepted[recognizer.accepted.length - 1];
  assertEqual(last.sampleRate, 48_000, 'the silence block uses the real capture rate');
  assertEqual(last.length, 48_000, 'one second of silence at that rate');
});

await runCase('finish with no audio at all falls back to the model rate', () => {
  const recognizer = createFakeRecognizer();
  const session = createVoiceRecognitionSession(recognizer.value);
  session.finish();
  assertDeepEqual(recognizer.accepted, [
    { sampleRate: FALLBACK_SAMPLE_RATE, length: FALLBACK_SAMPLE_RATE },
  ]);
});

await runCase('finish is idempotent and frees the stream exactly once', () => {
  const recognizer = createFakeRecognizer();
  recognizer.setResult('итог');
  const session = createVoiceRecognitionSession(recognizer.value);
  session.feed(16_000, new Float32Array(1600));
  assertEqual(session.finish(), 'итог');
  assertEqual(session.finish(), 'итог', 'a repeated finish returns the same text');
  assertEqual(recognizer.freeCalls, 1, 'the stream is freed once');
  assertEqual(recognizer.inputFinishedCalls, 1, 'input is closed once');
  assertEqual(session.done, true);
});

await runCase('feed after finish is ignored instead of touching a freed stream', () => {
  const recognizer = createFakeRecognizer();
  recognizer.setResult('итог');
  const session = createVoiceRecognitionSession(recognizer.value);
  session.finish();
  const acceptedAfterFinish = recognizer.accepted.length;
  assertEqual(session.feed(48_000, new Float32Array(4096)), 'итог');
  assertEqual(recognizer.accepted.length, acceptedAfterFinish, 'no waveform reached the freed stream');
});

console.log('voiceRecognitionSession.cases.test.ts — all passed');
```

**Implementation — `src/lib/voiceRecognitionSession.ts`:**

```ts
/**
 * Faithful port of the proven prototype's `Session` class, with the
 * already-found sample-rate bug fixed. Deliberately knows nothing about
 * Workers, WASM or any browser API: the recognizer is injected, so every
 * line here is exercised by voiceRecognitionSession.cases.test.ts.
 */

export interface VoiceRecognizerStreamLike {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  inputFinished(): void;
  free(): void;
}

export interface VoiceRecognizerLike {
  createStream(): VoiceRecognizerStreamLike;
  isReady(stream: VoiceRecognizerStreamLike): boolean;
  decode(stream: VoiceRecognizerStreamLike): void;
  getResult(stream: VoiceRecognizerStreamLike): { text: string };
}

export interface VoiceRecognitionSession {
  readonly done: boolean;
  readonly text: string;
  feed(sampleRate: number, samples: Float32Array): string;
  finish(): string;
}

/** The model's own feature rate; used only when nothing was ever fed. */
export const FALLBACK_SAMPLE_RATE = 16_000;

export function createVoiceRecognitionSession(
  recognizer: VoiceRecognizerLike,
): VoiceRecognitionSession {
  const stream = recognizer.createStream();
  let text = '';
  let done = false;
  let lastSampleRate = 0;

  const drain = (): string => {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    text = recognizer.getResult(stream).text;
    return text;
  };

  return {
    get done() { return done; },
    get text() { return text; },
    feed(sampleRate, samples) {
      if (done) return text;
      lastSampleRate = sampleRate;
      stream.acceptWaveform(sampleRate, samples);
      return drain();
    },
    finish() {
      if (done) return text;
      // One second of silence flushes the streaming decoder's tail. It has
      // to be a second of silence *at the rate the audio was actually
      // captured* -- a hardcoded 16000 here against a 48 kHz capture fed a
      // third of a second and cut the end of the last phrase.
      const sampleRate = lastSampleRate || FALLBACK_SAMPLE_RATE;
      stream.acceptWaveform(sampleRate, new Float32Array(sampleRate));
      stream.inputFinished();
      drain();
      done = true;
      stream.free();
      return text;
    },
  };
}
```

**Run:** `npx tsx src/lib/voiceRecognitionSession.cases.test.ts`
**Expected before implementation:** FAIL — module not found.
**Commit:** `feat(voice): port the recognizer session with the real capture rate on finish`

---

### Task 4: Bounded audio queue with drop-oldest backpressure

**Files:**
- Create: `src/lib/voiceRecognitionQueue.ts`
- Test: `src/lib/voiceRecognitionQueue.cases.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VoiceAudioChunk { sampleRate: number; samples: Float32Array }`, `VoiceRecognitionQueue`, `VOICE_QUEUE_CAPACITY`, `createVoiceRecognitionQueue(capacity?: number): VoiceRecognitionQueue`.

**Policy decision (do not re-litigate):** when the queue is full, **drop the oldest** chunk. Dropping the oldest keeps the queue holding the most recent speech, so the partial text the person is watching stays in step with what they are saying instead of drifting further behind, and the audio that is lost is the part the recognizer had not yet turned into any visible text — whereas dropping the newest would both grow the visible lag without bound and throw away exactly the words the person is waiting to see.

**Test — `src/lib/voiceRecognitionQueue.cases.test.ts` (shared preamble, then):**

```ts
import {
  createVoiceRecognitionQueue,
  VOICE_QUEUE_CAPACITY,
  type VoiceAudioChunk,
} from './voiceRecognitionQueue';

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
```

**Implementation — `src/lib/voiceRecognitionQueue.ts`:**

```ts
/**
 * Bounded audio-chunk queue. The prototype posted captured audio into the
 * worker with no limit at all: on a device that cannot decode in real time
 * the backlog grew for the whole recording, in memory nothing could cap.
 */

export interface VoiceAudioChunk {
  sampleRate: number;
  samples: Float32Array;
}

export interface VoiceRecognitionQueue {
  readonly size: number;
  readonly capacity: number;
  readonly droppedChunks: number;
  push(chunk: VoiceAudioChunk): void;
  shift(): VoiceAudioChunk | null;
  clear(): void;
}

/**
 * 24 blocks of 4096 frames is ~2.0 s of audio at 48 kHz and ~393 KB of
 * Float32 memory: long enough to absorb a normal decode hiccup, short
 * enough that the visible partial text never lags the speaker by more
 * than about two seconds.
 */
export const VOICE_QUEUE_CAPACITY = 24;

export function createVoiceRecognitionQueue(
  capacity: number = VOICE_QUEUE_CAPACITY,
): VoiceRecognitionQueue {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error('voice_queue_capacity_invalid');
  }

  const items: VoiceAudioChunk[] = [];
  let droppedChunks = 0;

  return {
    get size() { return items.length; },
    get capacity() { return capacity; },
    get droppedChunks() { return droppedChunks; },
    push(chunk) {
      if (items.length >= capacity) {
        // Drop the oldest, not the newest: the queue then always holds the
        // most recent speech, so the partial text stays in step with the
        // speaker, and the audio lost is the part no visible text came from.
        items.shift();
        droppedChunks += 1;
      }
      items.push(chunk);
    },
    shift() {
      return items.shift() ?? null;
    },
    clear() {
      items.length = 0;
    },
  };
}
```

**Run:** `npx tsx src/lib/voiceRecognitionQueue.cases.test.ts`
**Expected before implementation:** FAIL — module not found.
**Commit:** `feat(voice): add a bounded drop-oldest audio queue for worker backpressure`

---

### Task 5: Model package download, cache, delete

**Files:**
- Create: `src/lib/voiceModelCache.ts`
- Test: `src/lib/voiceModelCache.cases.test.ts`

**Interfaces:**
- Consumes: Task 1's `VoiceDictationPrepareProgress`.
- Produces: `VOICE_MODEL_REVISION`, `VOICE_MODEL_BASE_URL`, `VOICE_MODEL_CACHE_PREFIX`, `VOICE_MODEL_CACHE_NAME`, `VOICE_MODEL_DATA_FILE`, `VOICE_MODEL_WASM_FILE`, `VOICE_MODEL_DATA_BYTES`, `VOICE_MODEL_WASM_BYTES`, `VOICE_MODEL_TOTAL_BYTES`, `DOWNLOAD_STALL_TIMEOUT_MS`, `VoiceModelPrepareReason`, `VoiceModelPrepareError`, `VoiceModelPackage`, `AbortSignalLike`, `AbortControllerLike`, `ResponseLike`, `CacheLike`, `CacheStorageLike`, `VoiceModelCacheDeps`, `voiceModelFileUrl`, `isVoiceModelCached`, `loadVoiceModelPackage`, `deleteVoiceModelPackage`, `purgeStaleVoiceModelCaches`, `browserVoiceModelCacheDeps`.

**Implementation — `src/lib/voiceModelCache.ts`:**

```ts
import type { VoiceDictationPrepareProgress } from './voiceDictationContract';

/** Bump this one string when the model or engine build changes. */
export const VOICE_MODEL_REVISION = '83bbf6f-large-int8';
export const VOICE_MODEL_BASE_URL = `https://staysee.ru/voice-model/${VOICE_MODEL_REVISION}/`;
export const VOICE_MODEL_CACHE_PREFIX = 'staysee-voice-model-';
export const VOICE_MODEL_CACHE_NAME = `${VOICE_MODEL_CACHE_PREFIX}${VOICE_MODEL_REVISION}`;

export const VOICE_MODEL_DATA_FILE = 'sherpa-onnx-wasm-main-asr.data';
export const VOICE_MODEL_WASM_FILE = 'sherpa-onnx-wasm-main-asr.wasm';
export const VOICE_MODEL_DATA_BYTES = 71_694_239;
export const VOICE_MODEL_WASM_BYTES = 11_545_586;
export const VOICE_MODEL_TOTAL_BYTES = VOICE_MODEL_DATA_BYTES + VOICE_MODEL_WASM_BYTES;

/**
 * A download is judged dead only when it has received nothing at all for a
 * full minute. There is deliberately no overall deadline: even a 50 kbit/s
 * connection delivers a 16 KB body chunk every few seconds, so a slow but
 * living download keeps re-arming this watchdog, while a socket that has
 * gone silent for sixty seconds is genuinely stuck.
 */
export const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;

export type VoiceModelPrepareReason = 'network' | 'storage-full' | 'cancelled';

export class VoiceModelPrepareError extends Error {
  readonly reason: VoiceModelPrepareReason;

  constructor(reason: VoiceModelPrepareReason, message: string) {
    super(message);
    this.name = 'VoiceModelPrepareError';
    this.reason = reason;
  }
}

export interface VoiceModelPackage {
  dataBytes: ArrayBuffer;
  wasmBytes: ArrayBuffer;
  fromCache: boolean;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(): void;
}

export interface ResponseBodyReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: { getReader(): ResponseBodyReaderLike } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface CacheLike {
  match(request: string): Promise<ResponseLike | undefined>;
  put(request: string, response: ResponseLike): Promise<void>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

export interface VoiceModelCacheDeps {
  /** `null` when the browser context has no Cache Storage at all. */
  caches: CacheStorageLike | null;
  fetch(url: string, init: { signal: AbortSignalLike }): Promise<ResponseLike>;
  createResponse(bytes: ArrayBuffer): ResponseLike;
  createAbortController(): AbortControllerLike;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  now(): number;
}

interface ModelFile {
  name: string;
  bytes: number;
}

const FILES: readonly ModelFile[] = [
  { name: VOICE_MODEL_DATA_FILE, bytes: VOICE_MODEL_DATA_BYTES },
  { name: VOICE_MODEL_WASM_FILE, bytes: VOICE_MODEL_WASM_BYTES },
];

export function voiceModelFileUrl(fileName: string): string {
  return `${VOICE_MODEL_BASE_URL}${fileName}`;
}

function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const named = error as { name?: unknown; code?: unknown };
  return (
    named.name === 'QuotaExceededError'
    || named.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || named.code === 22
  );
}

async function openCache(deps: VoiceModelCacheDeps): Promise<CacheLike | null> {
  if (!deps.caches) return null;
  try {
    return await deps.caches.open(VOICE_MODEL_CACHE_NAME);
  } catch {
    // A context that advertises Cache Storage but refuses to open it is
    // treated exactly like one that has none: download into memory.
    return null;
  }
}

async function matchValid(cache: CacheLike, file: ModelFile): Promise<ResponseLike | null> {
  try {
    const hit = await cache.match(voiceModelFileUrl(file.name));
    if (!hit) return null;
    const header = hit.headers.get('content-length');
    const length = header === null ? Number.NaN : Number(header);
    // A truncated entry (an interrupted write, a partial eviction) must be
    // re-downloaded, never handed to the WASM engine as a valid model.
    return length === file.bytes ? hit : null;
  } catch {
    return null;
  }
}

export async function isVoiceModelCached(deps: VoiceModelCacheDeps): Promise<boolean> {
  const cache = await openCache(deps);
  if (!cache) return false;
  for (const file of FILES) {
    if (!(await matchValid(cache, file))) return false;
  }
  return true;
}

export async function deleteVoiceModelPackage(deps: VoiceModelCacheDeps): Promise<boolean> {
  if (!deps.caches) return false;
  try {
    // Exactly one named cache. Nothing enumerates, nothing else is touched:
    // the account, the conversations and every other site cache survive.
    return await deps.caches.delete(VOICE_MODEL_CACHE_NAME);
  } catch {
    return false;
  }
}

export async function purgeStaleVoiceModelCaches(deps: VoiceModelCacheDeps): Promise<string[]> {
  if (!deps.caches) return [];
  const removed: string[] = [];
  let names: string[];
  try {
    names = await deps.caches.keys();
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(VOICE_MODEL_CACHE_PREFIX)) continue;
    if (name === VOICE_MODEL_CACHE_NAME) continue;
    try {
      if (await deps.caches.delete(name)) removed.push(name);
    } catch {
      // A cache that refuses to be removed is not worth failing a session for.
    }
  }
  return removed;
}

interface DownloadContext {
  loadedBytes: number;
  onProgress(progress: VoiceDictationPrepareProgress): void;
}

async function downloadFile(
  deps: VoiceModelCacheDeps,
  file: ModelFile,
  options: { signal?: AbortSignalLike },
  context: DownloadContext,
): Promise<ArrayBuffer> {
  const controller = deps.createAbortController();
  const abortFromCaller = () => controller.abort();
  let lastProgressAt = deps.now();
  let stallTimerId: number | null = null;
  let stalled = false;

  if (options.signal) {
    if (options.signal.aborted) {
      throw new VoiceModelPrepareError('cancelled', 'voice_model_download_cancelled');
    }
    options.signal.addEventListener('abort', abortFromCaller);
  }

  const armStallTimer = () => {
    stallTimerId = deps.setTimeout(() => {
      stallTimerId = null;
      // Timers in a suspended or backgrounded tab fire late, never early.
      // Measuring the real gap means a laptop that slept for an hour
      // mid-download re-arms instead of killing a healthy download.
      if (deps.now() - lastProgressAt < DOWNLOAD_STALL_TIMEOUT_MS) {
        armStallTimer();
        return;
      }
      stalled = true;
      controller.abort();
    }, DOWNLOAD_STALL_TIMEOUT_MS);
  };

  const disarm = () => {
    if (stallTimerId !== null) deps.clearTimeout(stallTimerId);
    stallTimerId = null;
    options.signal?.removeEventListener('abort', abortFromCaller);
  };

  try {
    const response = await deps.fetch(voiceModelFileUrl(file.name), { signal: controller.signal });
    if (!response.ok) {
      // A revision-path typo arrives here as a 404 and must be loud.
      throw new VoiceModelPrepareError('network', `voice_model_http_${response.status}`);
    }

    let bytes: ArrayBuffer;
    if (!response.body) {
      bytes = await response.arrayBuffer();
      context.loadedBytes += bytes.byteLength;
      context.onProgress({ loadedBytes: context.loadedBytes, totalBytes: VOICE_MODEL_TOTAL_BYTES });
    } else {
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let received = 0;
      armStallTimer();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        if (!step.value) continue;
        parts.push(step.value);
        received += step.value.byteLength;
        lastProgressAt = deps.now();
        context.onProgress({
          loadedBytes: context.loadedBytes + received,
          totalBytes: VOICE_MODEL_TOTAL_BYTES,
        });
      }
      const merged = new Uint8Array(received);
      let offset = 0;
      for (const part of parts) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      parts.length = 0;
      context.loadedBytes += received;
      bytes = merged.buffer;
    }

    if (bytes.byteLength !== file.bytes) {
      // A short or over-long body means the deployed file is not the one
      // this revision was built against. Failing beats feeding the engine
      // bytes it will crash on, or silently caching a broken model.
      throw new VoiceModelPrepareError(
        'network',
        `voice_model_size_mismatch_${bytes.byteLength}`,
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof VoiceModelPrepareError) throw error;
    if (stalled) throw new VoiceModelPrepareError('network', 'voice_model_download_stalled');
    if (options.signal?.aborted) {
      throw new VoiceModelPrepareError('cancelled', 'voice_model_download_cancelled');
    }
    throw new VoiceModelPrepareError('network', 'voice_model_download_failed');
  } finally {
    disarm();
  }
}

export async function loadVoiceModelPackage(
  deps: VoiceModelCacheDeps,
  options: {
    onProgress(progress: VoiceDictationPrepareProgress): void;
    signal?: AbortSignalLike;
  },
): Promise<VoiceModelPackage> {
  await purgeStaleVoiceModelCaches(deps);
  const cache = await openCache(deps);

  if (cache) {
    const hits: ResponseLike[] = [];
    for (const file of FILES) {
      const hit = await matchValid(cache, file);
      if (!hit) { hits.length = 0; break; }
      hits.push(hit);
    }
    if (hits.length === FILES.length) {
      try {
        const dataBytes = await hits[0].arrayBuffer();
        const wasmBytes = await hits[1].arrayBuffer();
        return { dataBytes, wasmBytes, fromCache: true };
      } catch {
        // The entries looked right but would not read back; fall through
        // to a fresh download rather than failing the session.
      }
    }
  }

  const context: DownloadContext = { loadedBytes: 0, onProgress: options.onProgress };
  context.onProgress({ loadedBytes: 0, totalBytes: VOICE_MODEL_TOTAL_BYTES });
  const dataBytes = await downloadFile(deps, FILES[0], options, context);
  const wasmBytes = await downloadFile(deps, FILES[1], options, context);

  if (cache) {
    try {
      // Both files, not just the .data the prototype cached: the .wasm was
      // left to the ordinary HTTP cache and so was re-fetched whenever that
      // cache was evicted.
      await cache.put(voiceModelFileUrl(FILES[0].name), deps.createResponse(dataBytes));
      await cache.put(voiceModelFileUrl(FILES[1].name), deps.createResponse(wasmBytes));
    } catch (error) {
      // Leave no half-written package behind: it would be re-validated as
      // missing next time anyway, and it occupies the very disk space that
      // just ran out.
      await deleteVoiceModelPackage(deps);
      if (isQuotaError(error)) {
        throw new VoiceModelPrepareError('storage-full', 'voice_model_cache_quota_exceeded');
      }
      throw new VoiceModelPrepareError('network', 'voice_model_cache_write_failed');
    }
  }

  return { dataBytes, wasmBytes, fromCache: false };
}

export function browserVoiceModelCacheDeps(): VoiceModelCacheDeps {
  const cacheStorage = typeof window !== 'undefined' && 'caches' in window
    ? (window.caches as unknown as CacheStorageLike)
    : null;
  return {
    caches: cacheStorage,
    fetch: (url, init) => fetch(url, {
      signal: init.signal as unknown as AbortSignal,
      cache: 'default',
    }) as unknown as Promise<ResponseLike>,
    createResponse: (bytes) => new Response(bytes, {
      headers: {
        // Cache Storage preserves these; the length is what revalidates a
        // cached entry without reading 83 MB back off disk.
        'content-length': String(bytes.byteLength),
        'content-type': 'application/octet-stream',
      },
    }) as unknown as ResponseLike,
    createAbortController: () => new AbortController() as unknown as AbortControllerLike,
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    now: () => Date.now(),
  };
}
```

**Note on peak memory:** the download is buffered in JS and then handed to `createResponse`, so peak transient use is roughly two copies of the larger file (~140 MB) while `cache.put` drains. This is the simplest shape that keeps real byte progress testable; if a low-memory device ever fails here, the fix is to pipe the body through a counting `TransformStream` straight into `cache.put` and read the bytes back from the cache, not to remove progress reporting.

**Why a quota failure is fatal rather than best-effort:** the person consented to a one-time ~83 MB download. Proceeding with un-cached bytes would silently re-download 83 MB on every future session without ever asking again, which is exactly what product rule 7 forbids. A clear "not enough space" error lets them free space and retry.

**Test — `src/lib/voiceModelCache.cases.test.ts` (shared preamble, then):**

```ts
import type { VoiceDictationPrepareProgress } from './voiceDictationContract';
import {
  browserVoiceModelCacheDeps,
  deleteVoiceModelPackage,
  DOWNLOAD_STALL_TIMEOUT_MS,
  isVoiceModelCached,
  loadVoiceModelPackage,
  purgeStaleVoiceModelCaches,
  voiceModelFileUrl,
  VOICE_MODEL_CACHE_NAME,
  VOICE_MODEL_DATA_BYTES,
  VOICE_MODEL_DATA_FILE,
  VOICE_MODEL_TOTAL_BYTES,
  VOICE_MODEL_WASM_BYTES,
  VOICE_MODEL_WASM_FILE,
  VoiceModelPrepareError,
  type CacheLike,
  type CacheStorageLike,
  type ResponseLike,
  type VoiceModelCacheDeps,
} from './voiceModelCache';

function fakeResponse(byteLength: number, options: { ok?: boolean; status?: number; chunks?: number } = {}): ResponseLike {
  const chunks = options.chunks ?? 2;
  const perChunk = Math.ceil(byteLength / chunks);
  let sent = 0;
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: { get: (name) => (name === 'content-length' ? String(byteLength) : null) },
    body: {
      getReader: () => ({
        async read() {
          if (sent >= byteLength) return { done: true };
          const size = Math.min(perChunk, byteLength - sent);
          sent += size;
          return { done: false, value: new Uint8Array(size) };
        },
      }),
    },
    arrayBuffer: async () => new ArrayBuffer(byteLength),
  };
}

function createFakeDeps(options: {
  cached?: boolean;
  cachedDataBytes?: number;
  noCacheStorage?: boolean;
  putError?: unknown;
  otherCaches?: string[];
  responses?: Record<string, ResponseLike>;
} = {}) {
  const stored = new Map<string, ResponseLike>();
  if (options.cached) {
    stored.set(voiceModelFileUrl(VOICE_MODEL_DATA_FILE), fakeResponse(options.cachedDataBytes ?? VOICE_MODEL_DATA_BYTES));
    stored.set(voiceModelFileUrl(VOICE_MODEL_WASM_FILE), fakeResponse(VOICE_MODEL_WASM_BYTES));
  }
  const fetchedUrls: string[] = [];
  const deletedCaches: string[] = [];
  const putUrls: string[] = [];
  const openedCaches: string[] = [];
  const names = new Set<string>([...(options.otherCaches ?? [])]);
  if (options.cached) names.add(VOICE_MODEL_CACHE_NAME);
  const abortedSignals: boolean[] = [];
  let nextTimerId = 1;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let now = 1_000;

  const cache: CacheLike = {
    async match(request) { return stored.get(request); },
    async put(request, response) {
      if (options.putError) throw options.putError;
      putUrls.push(request);
      stored.set(request, response);
      names.add(VOICE_MODEL_CACHE_NAME);
    },
  };

  const cacheStorage: CacheStorageLike = {
    async open(name) { openedCaches.push(name); return cache; },
    async keys() { return [...names]; },
    async delete(name) {
      deletedCaches.push(name);
      if (name === VOICE_MODEL_CACHE_NAME) stored.clear();
      return names.delete(name);
    },
  };

  const value: VoiceModelCacheDeps = {
    caches: options.noCacheStorage ? null : cacheStorage,
    async fetch(url, init) {
      fetchedUrls.push(url);
      abortedSignals.push(init.signal.aborted);
      const scripted = options.responses?.[url];
      if (scripted) return scripted;
      const expected = url.endsWith(VOICE_MODEL_DATA_FILE) ? VOICE_MODEL_DATA_BYTES : VOICE_MODEL_WASM_BYTES;
      return fakeResponse(expected);
    },
    createResponse: (bytes) => fakeResponse(bytes.byteLength),
    createAbortController() {
      const listeners: Array<() => void> = [];
      let aborted = false;
      return {
        signal: {
          get aborted() { return aborted; },
          addEventListener(_type, listener) { listeners.push(listener); },
          removeEventListener() { /* nothing to detach in the fake */ },
        },
        abort() {
          aborted = true;
          for (const listener of listeners) listener();
        },
      };
    },
    setTimeout(callback, ms) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    now: () => now,
  };

  return {
    value,
    fetchedUrls,
    deletedCaches,
    putUrls,
    openedCaches,
    get cacheNames() { return [...names]; },
    advance(ms: number) { now += ms; },
    fireTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.callback();
    },
    get pendingTimers() { return timers.size; },
  };
}

function externalSignal() {
  const listeners: Array<() => void> = [];
  let aborted = false;
  return {
    value: {
      get aborted() { return aborted; },
      addEventListener(_type: 'abort', listener: () => void) { listeners.push(listener); },
      removeEventListener() { /* nothing to detach in the fake */ },
    },
    abort() { aborted = true; for (const listener of listeners) listener(); },
  };
}

await runCase('the live model URLs and sizes are pinned exactly', () => {
  // Review Focus 4: a typo in a future revision path, or a stale byte
  // count, must fail here and not in a user's browser.
  assertEqual(
    voiceModelFileUrl(VOICE_MODEL_DATA_FILE),
    'https://staysee.ru/voice-model/83bbf6f-large-int8/sherpa-onnx-wasm-main-asr.data',
  );
  assertEqual(
    voiceModelFileUrl(VOICE_MODEL_WASM_FILE),
    'https://staysee.ru/voice-model/83bbf6f-large-int8/sherpa-onnx-wasm-main-asr.wasm',
  );
  assertEqual(VOICE_MODEL_DATA_BYTES, 71_694_239);
  assertEqual(VOICE_MODEL_WASM_BYTES, 11_545_586);
  assertEqual(VOICE_MODEL_TOTAL_BYTES, 83_239_825);
  assertEqual(VOICE_MODEL_CACHE_NAME, 'staysee-voice-model-83bbf6f-large-int8');
  assert(typeof browserVoiceModelCacheDeps === 'function', 'a browser deps factory is exported');
});

await runCase('a first download reports progress across both files and caches both', async () => {
  const deps = createFakeDeps();
  const progress: VoiceDictationPrepareProgress[] = [];
  const result = await loadVoiceModelPackage(deps.value, { onProgress: (next) => progress.push(next) });
  assertEqual(result.fromCache, false);
  assertEqual(result.dataBytes.byteLength, VOICE_MODEL_DATA_BYTES);
  assertEqual(result.wasmBytes.byteLength, VOICE_MODEL_WASM_BYTES);
  assertEqual(progress[0].loadedBytes, 0, 'progress opens at zero so a bar can appear at once');
  assertEqual(progress[0].totalBytes, VOICE_MODEL_TOTAL_BYTES);
  assertEqual(progress[progress.length - 1].loadedBytes, VOICE_MODEL_TOTAL_BYTES, 'and ends at the total');
  assertDeepEqual(deps.putUrls, [
    voiceModelFileUrl(VOICE_MODEL_DATA_FILE),
    voiceModelFileUrl(VOICE_MODEL_WASM_FILE),
  ], 'both the model data and the engine wasm are cached');
});

await runCase('a cached, correctly sized package skips the network entirely', async () => {
  const deps = createFakeDeps({ cached: true });
  assertEqual(await isVoiceModelCached(deps.value), true);
  const result = await loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  assertEqual(result.fromCache, true);
  assertDeepEqual(deps.fetchedUrls, [], 'nothing was downloaded again');
});

await runCase('a cached entry with the wrong length is re-downloaded', async () => {
  const deps = createFakeDeps({ cached: true, cachedDataBytes: 1_024 });
  assertEqual(await isVoiceModelCached(deps.value), false, 'a truncated entry is not a valid package');
  const result = await loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  assertEqual(result.fromCache, false);
  assertEqual(deps.fetchedUrls.length, 2, 'both files were fetched fresh');
});

await runCase('a quota failure reports storage-full and leaves no half-written cache', async () => {
  const quota = Object.assign(new Error('out of space'), { name: 'QuotaExceededError' });
  const deps = createFakeDeps({ putError: quota });
  let caught: unknown = null;
  try {
    await loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  } catch (error) { caught = error; }
  assert(caught instanceof VoiceModelPrepareError, 'a specific prepare error, not a generic one');
  assertEqual((caught as VoiceModelPrepareError).reason, 'storage-full');
  assert(
    deps.deletedCaches.includes(VOICE_MODEL_CACHE_NAME),
    'the partially written package was removed',
  );
  assertEqual(await isVoiceModelCached(deps.value), false, 'and nothing is left to mistake for a package');
});

await runCase('delete removes only the voice package cache', async () => {
  const deps = createFakeDeps({ cached: true, otherCaches: ['workbox-precache', 'staysee-images'] });
  assertEqual(await deleteVoiceModelPackage(deps.value), true);
  assertDeepEqual(deps.deletedCaches, [VOICE_MODEL_CACHE_NAME], 'exactly one named cache was targeted');
  assert(deps.cacheNames.includes('workbox-precache'), 'unrelated caches survive');
  assert(deps.cacheNames.includes('staysee-images'), 'unrelated caches survive');
});

await runCase('stale revision caches are purged and unrelated ones are kept', async () => {
  const deps = createFakeDeps({
    cached: true,
    otherCaches: ['staysee-voice-model-oldrev-large-int8', 'staysee-images'],
  });
  const removed = await purgeStaleVoiceModelCaches(deps.value);
  assertDeepEqual(removed, ['staysee-voice-model-oldrev-large-int8']);
  assert(deps.cacheNames.includes(VOICE_MODEL_CACHE_NAME), 'the current package survives');
  assert(deps.cacheNames.includes('staysee-images'), 'unrelated caches survive');
});

await runCase('a download that receives nothing for a full minute fails as a prepare error', async () => {
  const stuck: ResponseLike = {
    ok: true,
    status: 200,
    headers: { get: () => String(VOICE_MODEL_DATA_BYTES) },
    body: { getReader: () => ({ read: () => new Promise(() => undefined) }) },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const deps = createFakeDeps({ responses: { [voiceModelFileUrl(VOICE_MODEL_DATA_FILE)]: stuck } });
  const pending = loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  await Promise.resolve();
  await Promise.resolve();
  deps.advance(DOWNLOAD_STALL_TIMEOUT_MS);
  deps.fireTimers();
  let caught: unknown = null;
  try { await pending; } catch (error) { caught = error; }
  assert(caught instanceof VoiceModelPrepareError);
  assertEqual((caught as VoiceModelPrepareError).reason, 'network');
});

await runCase('a tab that slept mid-download re-arms instead of failing', async () => {
  // Review Focus 1: the watchdog timer fires late after a suspend, so it
  // must judge by real elapsed time since the last byte, not by firing.
  let released: (() => void) | null = null;
  let delivered = false;
  const slow: ResponseLike = {
    ok: true,
    status: 200,
    headers: { get: () => String(VOICE_MODEL_DATA_BYTES) },
    body: {
      getReader: () => ({
        read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
          if (delivered) { resolve({ done: true }); return; }
          released = () => { delivered = true; resolve({ done: false, value: new Uint8Array(VOICE_MODEL_DATA_BYTES) }); };
        }),
      }),
    },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const deps = createFakeDeps({ responses: { [voiceModelFileUrl(VOICE_MODEL_DATA_FILE)]: slow } });
  const pending = loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  await Promise.resolve();
  await Promise.resolve();
  // The timer fires, but only 1 ms of real time has passed.
  deps.advance(1);
  deps.fireTimers();
  assert(deps.pendingTimers > 0, 'the watchdog re-armed rather than failing the download');
  released?.();
  const result = await pending;
  assertEqual(result.dataBytes.byteLength, VOICE_MODEL_DATA_BYTES, 'the download completed normally');
});

await runCase('a missing Cache Storage still prepares, in memory', async () => {
  // Review Focus 5.
  const deps = createFakeDeps({ noCacheStorage: true });
  assertEqual(await isVoiceModelCached(deps.value), false);
  const result = await loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  assertEqual(result.fromCache, false);
  assertEqual(result.dataBytes.byteLength, VOICE_MODEL_DATA_BYTES, 'voice input still works this session');
  assertEqual(await deleteVoiceModelPackage(deps.value), false, 'deleting is a harmless no-op');
  assertDeepEqual(await purgeStaleVoiceModelCaches(deps.value), []);
});

await runCase('cancelling aborts the in-flight fetch and reports cancelled', async () => {
  let released: ((step: { done: boolean; value?: Uint8Array }) => void) | null = null;
  const slow: ResponseLike = {
    ok: true,
    status: 200,
    headers: { get: () => String(VOICE_MODEL_DATA_BYTES) },
    body: { getReader: () => ({ read: () => new Promise((resolve) => { released = resolve; }) }) },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const deps = createFakeDeps({ responses: { [voiceModelFileUrl(VOICE_MODEL_DATA_FILE)]: slow } });
  const signal = externalSignal();
  const pending = loadVoiceModelPackage(deps.value, { onProgress: () => undefined, signal: signal.value });
  await Promise.resolve();
  await Promise.resolve();
  signal.abort();
  released?.({ done: true });
  let caught: unknown = null;
  try { await pending; } catch (error) { caught = error; }
  assert(caught instanceof VoiceModelPrepareError);
  assertEqual((caught as VoiceModelPrepareError).reason, 'cancelled');
});

await runCase('an HTTP 404 from a mistyped revision path fails as a prepare error', async () => {
  const missing: ResponseLike = {
    ok: false,
    status: 404,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const deps = createFakeDeps({ responses: { [voiceModelFileUrl(VOICE_MODEL_DATA_FILE)]: missing } });
  let caught: unknown = null;
  try { await loadVoiceModelPackage(deps.value, { onProgress: () => undefined }); } catch (error) { caught = error; }
  assert(caught instanceof VoiceModelPrepareError);
  assertEqual((caught as VoiceModelPrepareError).reason, 'network');
});

await runCase('a short body fails instead of reaching the engine', async () => {
  const short = fakeResponse(VOICE_MODEL_DATA_BYTES - 1);
  const deps = createFakeDeps({ responses: { [voiceModelFileUrl(VOICE_MODEL_DATA_FILE)]: short } });
  let caught: unknown = null;
  try { await loadVoiceModelPackage(deps.value, { onProgress: () => undefined }); } catch (error) { caught = error; }
  assert(caught instanceof VoiceModelPrepareError);
  assertEqual((caught as VoiceModelPrepareError).reason, 'network');
  assertDeepEqual(deps.putUrls, [], 'a broken download is never cached');
});

await runCase('a cache another tab filled mid-download is overwritten, not an error', async () => {
  // Review Focus 2, storage half: two tabs can both download and both
  // write. The second write must simply win.
  const deps = createFakeDeps();
  await loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  const second = await loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  assertEqual(second.fromCache, true, 'the second attempt now reads the cache the first filled');
});

console.log('voiceModelCache.cases.test.ts — all passed');
```

**Run:** `npx tsx src/lib/voiceModelCache.cases.test.ts`
**Expected before implementation:** FAIL — module not found.
**Commit:** `feat(voice): add on-device model package download, caching and deletion`

---

### Task 6: Vendor the sherpa-onnx engine scripts and configure Vite for a module worker

**Files:**
- Create: `public/voice-engine/sherpa-onnx-asr.js` (copied, 41,274 bytes)
- Create: `public/voice-engine/sherpa-onnx-wasm-main-asr.js` (copied, 92,139 bytes)
- Create: `public/voice-engine/ORIGIN.md`
- Modify: `vite.config.ts`
- Modify: `scripts/verify-prod-bundle.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: the runtime URLs `/voice-engine/sherpa-onnx-asr.js` and `/voice-engine/sherpa-onnx-wasm-main-asr.js`, in that load order; `worker: { format: 'es' }` build behaviour.

- [ ] **Step 1: Copy the two vendored engine scripts**

```bash
mkdir -p public/voice-engine
cp "/c/Users/Я/.codex/visualizations/2026/08/01/019fbdfa-8036-7e63-9feb-b375d67506cc/zipformer-probe/large-int8/sherpa-onnx-asr.js" public/voice-engine/sherpa-onnx-asr.js
cp "/c/Users/Я/.codex/visualizations/2026/08/01/019fbdfa-8036-7e63-9feb-b375d67506cc/zipformer-probe/large-int8/sherpa-onnx-wasm-main-asr.js" public/voice-engine/sherpa-onnx-wasm-main-asr.js
```

- [ ] **Step 2: Verify the copies are byte-exact**

```bash
stat -c '%s %n' public/voice-engine/sherpa-onnx-asr.js public/voice-engine/sherpa-onnx-wasm-main-asr.js
```
Expected: `41274 …/sherpa-onnx-asr.js` and `92139 …/sherpa-onnx-wasm-main-asr.js`. If either differs, the copy is wrong — stop and re-copy.

- [ ] **Step 3: Write `public/voice-engine/ORIGIN.md`**

```markdown
# Vendored sherpa-onnx WebAssembly engine

These two files are redistributed unchanged, byte for byte, as part of
StaySee's on-device Russian voice dictation. They are served from
`/voice-engine/` and loaded by `src/lib/voiceRecognitionWorker.ts`, in this
order: `sherpa-onnx-asr.js` first (it defines `createOnlineRecognizer`),
then `sherpa-onnx-wasm-main-asr.js` (the Emscripten runtime, which reads
the `Module` object the worker has already placed on the global scope).

| File | Bytes | Source |
| --- | --- | --- |
| `sherpa-onnx-asr.js` | 41274 | k2-fsa/sherpa-onnx v1.12.20, WebAssembly ASR JavaScript wrapper |
| `sherpa-onnx-wasm-main-asr.js` | 92139 | k2-fsa/sherpa-onnx v1.12.20, Emscripten glue for the SIMD WASM ASR build |

Engine: https://github.com/k2-fsa/sherpa-onnx — Apache License 2.0.
Model (downloaded at runtime, not stored here): `alphacep/vosk-model-streaming-ru`,
revision `83bbf6f`, Large INT8 variant — Apache License 2.0.

Apache 2.0 requires that this attribution travel with the redistributed
files. The user-facing licence notice is added by the chat-integration plan
(Part 2); this file is the in-repository record.

Do not edit, minify, reformat or lint these two files. Replacing them means
a new engine build: update the byte counts here and in
`scripts/verify-prod-bundle.mjs`, and re-run the recognition comparison
described in the design document before shipping.
```

- [ ] **Step 4: Replace `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  worker: {
    // The voice recognition worker is created with
    // `new Worker(new URL('./voiceRecognitionWorker.ts', import.meta.url),
    // { type: 'module' })` and has real ES imports. Vite's dev server
    // serves such a worker unbundled, so a classic worker would hit a
    // "Cannot use import statement outside a module" error in dev while
    // working in production. 'es' makes dev and build agree.
    format: 'es',
  },
});
```

- [ ] **Step 5: Add the engine-asset guard to `scripts/verify-prod-bundle.mjs`**

Insert immediately before the final `console.log('[verify-prod-bundle] OK …')` line:

```js
/**
 * The on-device voice engine is served from public/ and is not referenced
 * from index.html, so nothing else in the build would notice if it went
 * missing. Without these two files local dictation cannot start at all.
 * Replacing the engine means updating these byte counts on purpose.
 */
const engineFiles = [
  ['sherpa-onnx-asr.js', 41274],
  ['sherpa-onnx-wasm-main-asr.js', 92139],
];
for (const [name, expectedBytes] of engineFiles) {
  const enginePath = path.join(process.cwd(), 'dist', 'voice-engine', name);
  if (!fs.existsSync(enginePath)) {
    console.error(`[verify-prod-bundle] dist/voice-engine/${name} is missing — on-device voice input cannot start`);
    process.exit(1);
  }
  const actualBytes = fs.statSync(enginePath).size;
  if (actualBytes !== expectedBytes) {
    console.error(`[verify-prod-bundle] dist/voice-engine/${name} is ${actualBytes} bytes, expected ${expectedBytes}`);
    process.exit(1);
  }
}
```

- [ ] **Step 6: Run the build guard and confirm it passes**

Run: `npm run build`
Expected: `[verify-prod-bundle] OK — no direct supabase.co / openrouter in dist`, with no engine-file error. Then confirm the guard actually bites:

```bash
mv dist/voice-engine/sherpa-onnx-asr.js dist/voice-engine/sherpa-onnx-asr.js.bak && node scripts/verify-prod-bundle.mjs; mv dist/voice-engine/sherpa-onnx-asr.js.bak dist/voice-engine/sherpa-onnx-asr.js
```
Expected: the script prints the missing-file error and exits non-zero, then the file is restored.

- [ ] **Step 7: Commit**

```bash
git add public/voice-engine vite.config.ts scripts/verify-prod-bundle.mjs
git commit -m "feat(voice): vendor the sherpa-onnx engine and build module workers as ES"
```

---

### Task 7: AudioWorklet capture processor

**Files:**
- Create: `src/lib/voiceCaptureProcessor.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a processor registered under the name `voice-capture`, posting a `Float32Array` of exactly 4096 frames per message on its `port`, with the buffer transferred.

**Why there is no unit test:** this file runs in `AudioWorkletGlobalScope`, where `AudioWorkletProcessor`, `registerProcessor` and `currentFrame` exist and nothing else does. There is no Node equivalent and this repo has no browser test environment (verified: `scripts/run-offline-tests.mjs` runs `tsx --test` only, and `package.json` has no testing library). It is therefore kept to the minimum that can be read at a glance; the integration that uses it is tested in Task 10 through the injected `LocalAudioContextLike` fake, and its presence in the build is enforced in Task 11.

- [ ] **Step 1: Write `src/lib/voiceCaptureProcessor.js`**

```js
/**
 * AudioWorkletProcessor for StaySee on-device voice dictation.
 *
 * Replaces the prototype's deprecated ScriptProcessorNode, which ran its
 * callback on the main thread and so competed with React rendering.
 *
 * Deliberately mechanical: it accumulates the render quanta the audio
 * thread hands it into 4096-frame blocks -- the same block size the
 * prototype used, and about 85 ms at 48 kHz, instead of 128 frames every
 * 2.7 ms -- and posts each full block to the main thread with its buffer
 * transferred. It measures nothing, decides nothing and keeps no history.
 *
 * Not type-checked (tsconfig.app.json has no allowJs) and not linted
 * (eslint.config.js covers only .ts/.tsx). Verified by `node --check`,
 * by src/lib/localVoiceDictation.cases.test.ts through the injected
 * AudioContext fake, and by scripts/verify-prod-bundle.mjs in the build.
 */
const CAPTURE_BLOCK_FRAMES = 4096;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(CAPTURE_BLOCK_FRAMES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      this.block[this.filled] = channel[index];
      this.filled += 1;
      if (this.filled === CAPTURE_BLOCK_FRAMES) {
        const full = this.block;
        this.block = new Float32Array(CAPTURE_BLOCK_FRAMES);
        this.filled = 0;
        this.port.postMessage(full, [full.buffer]);
      }
    }
    // The output buffer is left untouched, so this node is silent and
    // connecting it to the destination causes no echo. Returning true keeps
    // the processor alive for as long as the node is connected.
    return true;
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor);
```

- [ ] **Step 2: Verify it parses and registers the expected name**

Run:
```bash
node --check src/lib/voiceCaptureProcessor.js && grep -c "registerProcessor('voice-capture'" src/lib/voiceCaptureProcessor.js
```
Expected: no parse error, and `1`.

- [ ] **Step 3: Confirm it is excluded from TypeScript and ESLint as assumed**

Run: `npm run typecheck && npm run lint`
Expected: both pass with no mention of `voiceCaptureProcessor.js`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/voiceCaptureProcessor.js
git commit -m "feat(voice): add the AudioWorklet capture processor"
```

---

### Task 8: Recognition worker entry point

**Files:**
- Create: `src/lib/voiceRecognitionWorker.ts`

**Interfaces:**
- Consumes: Task 3's `createVoiceRecognitionSession`, `VoiceRecognizerLike`, `VoiceRecognitionSession`; Task 4's `createVoiceRecognitionQueue`.
- Produces (imported by Task 9 with `import type` only, so no worker code reaches the main bundle): `VoiceWorkerLoadRequest`, `VoiceWorkerStartRequest`, `VoiceWorkerFinishRequest`, `VoiceWorkerAudioRequest`, `VoiceWorkerRequest`, `VoiceWorkerReply { id: number; ok: boolean; error?: string; text?: string }`, `VoiceWorkerPartial { type: 'partial'; text: string }`, `VoiceWorkerMessage`, `VOICE_RECOGNIZER_CONFIG`.

**Why there is no unit test:** instantiating this module means instantiating an 11 MB WASM engine and a 68 MB model inside a real `Worker`. No such environment exists here (see Task 7's note). Everything in it that could be decided has already been moved into Tasks 3 and 4; what remains is wiring. If an implementer finds themselves wanting to test logic inside this file, that logic belongs in `voiceRecognitionSession.ts` or `voiceRecognitionQueue.ts` instead.

- [ ] **Step 1: Write `src/lib/voiceRecognitionWorker.ts`**

```ts
import {
  createVoiceRecognitionSession,
  type VoiceRecognitionSession,
  type VoiceRecognizerLike,
} from './voiceRecognitionSession';
import { createVoiceRecognitionQueue } from './voiceRecognitionQueue';

export interface VoiceWorkerLoadRequest {
  id: number;
  type: 'load';
  dataBytes: ArrayBuffer;
  wasmBytes: ArrayBuffer;
  modelBaseUrl: string;
  /** Loaded in order: the ASR wrapper first, then the Emscripten runtime. */
  engineScriptUrls: string[];
}
export interface VoiceWorkerStartRequest { id: number; type: 'start' }
export interface VoiceWorkerFinishRequest { id: number; type: 'finish' }
export interface VoiceWorkerAudioRequest {
  type: 'audio';
  sampleRate: number;
  samples: Float32Array;
}
export type VoiceWorkerRequest =
  | VoiceWorkerLoadRequest
  | VoiceWorkerStartRequest
  | VoiceWorkerFinishRequest
  | VoiceWorkerAudioRequest;

export interface VoiceWorkerReply {
  id: number;
  ok: boolean;
  /** Engine diagnostics. For this module's own logs only; never shown. */
  error?: string;
  text?: string;
}
export interface VoiceWorkerPartial {
  type: 'partial';
  text: string;
}
export type VoiceWorkerMessage = VoiceWorkerReply | VoiceWorkerPartial;

/**
 * Exactly the configuration the working prototype used. Changing any value
 * here requires re-running recognition on the same audio before and after
 * and comparing the transcripts, per the design document.
 */
export const VOICE_RECOGNIZER_CONFIG = {
  featConfig: { sampleRate: 16_000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: '/encoder.onnx',
      decoder: '/decoder.onnx',
      joiner: '/joiner.onnx',
    },
    tokens: '/tokens.txt',
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    modelType: 'zipformer2',
  },
  decodingMethod: 'modified_beam_search',
  maxActivePaths: 10,
  enableEndpoint: 0,
} as const;

type EmscriptenModule = Record<string, unknown>;

interface EngineScope {
  Module?: EmscriptenModule;
  createOnlineRecognizer?: (
    module: EmscriptenModule,
    config: unknown,
  ) => VoiceRecognizerLike & { handle?: unknown };
  postMessage(message: VoiceWorkerMessage): void;
  onmessage: ((event: { data: VoiceWorkerRequest }) => void) | null;
  fetch(url: string): Promise<{ ok: boolean; text(): Promise<string> }>;
}

const scope = self as unknown as EngineScope;

const queue = createVoiceRecognitionQueue();
let recognizer: (VoiceRecognizerLike & { handle?: unknown }) | null = null;
let session: VoiceRecognitionSession | null = null;
let diagnostics: string[] = [];
let draining = false;

/**
 * This is a module worker, so `importScripts` does not exist -- it has to be
 * a module worker because Vite's dev server always instantiates workers
 * created from `new URL(..., import.meta.url)` as modules, and the ES
 * imports above would be a syntax error in a classic one. Indirect eval is
 * the exact equivalent: unlike `new Function`, it evaluates in global
 * scope, so the engine's own top-level `var` and `function` declarations
 * land on `self` just as importScripts would put them there.
 */
async function loadEngineScript(url: string): Promise<void> {
  const response = await scope.fetch(url);
  if (!response.ok) throw new Error('engine_script_unavailable');
  const source = await response.text();
  const indirectEval = eval;
  indirectEval(`${source}\n//# sourceURL=${url}`);
}

async function load(request: VoiceWorkerLoadRequest): Promise<void> {
  const dataBytes = request.dataBytes;
  await new Promise<void>((resolve, reject) => {
    scope.Module = {
      // Both large files come in already downloaded and verified by
      // voiceModelCache.ts, so the engine performs no network access of its
      // own -- this is also what makes caching the .wasm effective, which
      // the prototype never did.
      wasmBinary: request.wasmBytes,
      getPreloadedPackage: () => dataBytes,
      locateFile: (path: string) => `${request.modelBaseUrl}${path}`,
      print: () => undefined,
      printErr: (line: unknown) => {
        diagnostics.push(String(line));
        diagnostics = diagnostics.slice(-8);
      },
      onAbort: (reason: unknown) => reject(new Error(String(reason))),
      onRuntimeInitialized: () => resolve(),
    };
    void (async () => {
      try {
        for (const url of request.engineScriptUrls) await loadEngineScript(url);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });

  const factory = scope.createOnlineRecognizer;
  if (!factory) throw new Error('engine_factory_missing');
  // The Emscripten glue reuses the `Module` object placed above, so this is
  // the initialised runtime. `createOnlineRecognizer` is used rather than
  // `new OnlineRecognizer(...)` because it is a top-level function
  // declaration and therefore reachable after an indirect eval, whereas the
  // class is a lexical binding and would not be.
  const next = factory(scope.Module as EmscriptenModule, VOICE_RECOGNIZER_CONFIG);
  if (!next.handle) throw new Error('model_not_opened');
  recognizer = next;
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      if (!session) break;
      const chunk = queue.shift();
      if (!chunk) break;
      scope.postMessage({ type: 'partial', text: session.feed(chunk.sampleRate, chunk.samples) });
      // Yield a whole macrotask so that queued `audio` messages actually
      // reach onmessage and the bounded queue. Decoding synchronously
      // inside onmessage -- as the prototype did -- let the backlog pile up
      // in the worker's own message queue, which nothing can cap.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    }
  } finally {
    draining = false;
  }
}

/**
 * Feed whatever is left synchronously. Nothing needs to yield now: the
 * session is ending, and a drain that is mid-yield will find the queue empty
 * and then no-op against a finished session.
 */
function feedRemaining(): void {
  if (!session) return;
  for (;;) {
    const chunk = queue.shift();
    if (!chunk) break;
    session.feed(chunk.sampleRate, chunk.samples);
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'audio') {
    queue.push({ sampleRate: request.sampleRate, samples: request.samples });
    void drainQueue();
    return;
  }

  void (async () => {
    try {
      if (request.type === 'load') {
        await load(request);
      } else if (request.type === 'start') {
        if (!recognizer) throw new Error('engine_not_loaded');
        queue.clear();
        if (session && !session.done) session.finish();
        session = createVoiceRecognitionSession(recognizer);
      } else {
        if (!session) throw new Error('session_not_started');
        feedRemaining();
        scope.postMessage({ id: request.id, ok: true, text: session.finish() });
        return;
      }
      scope.postMessage({ id: request.id, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      scope.postMessage({
        id: request.id,
        ok: false,
        // The adapter never forwards this string anywhere a person can see
        // it; it exists so a developer reading a console has something.
        error: diagnostics.length ? `${message} | ${diagnostics.join(' | ')}` : message,
      });
    }
  })();
};
```

- [ ] **Step 2: Verify it type-checks and lints**

Run: `npm run typecheck && npx eslint src/lib/voiceRecognitionWorker.ts`
Expected: both clean. (`no-eval` is not part of `js.configs.recommended`, so the indirect eval does not need a disable comment; if a future config enables it, the fix is a scoped `// eslint-disable-next-line no-eval`, not a redesign.)

- [ ] **Step 3: Confirm the recognizer configuration matches the prototype exactly**

Run:
```bash
grep -nE "sampleRate: 16_000|featureDim: 80|zipformer2|modified_beam_search|maxActivePaths: 10|enableEndpoint: 0|numThreads: 1|provider: 'cpu'" src/lib/voiceRecognitionWorker.ts
```
Expected: all eight values present. Any deviation is a design change that needs an A/B transcript comparison first.

- [ ] **Step 4: Commit**

```bash
git add src/lib/voiceRecognitionWorker.ts
git commit -m "feat(voice): add the on-device recognition worker entry point"
```

---

### Task 9: Local adapter — support detection and the preparation phase

**Files:**
- Create: `src/lib/localVoiceDictation.ts`
- Test: `src/lib/localVoiceDictation.cases.test.ts`

**Interfaces:**
- Consumes: Task 1's contract, Task 5's `VoiceModelPackage`/`AbortSignalLike`/`AbortControllerLike`/`VOICE_MODEL_TOTAL_BYTES`/`VOICE_MODEL_BASE_URL`/`browserVoiceModelCacheDeps`/`isVoiceModelCached`/`loadVoiceModelPackage`, Task 8's `import type` protocol.
- Produces: `MessagePortLike`, `VoiceCaptureGraph`, `MediaStreamTrackLike`, `MediaStreamLike`, `LocalAudioContextLike`, `VoiceWorkerLike`, `LocalVoiceModelAccess`, `LocalVoicePlatform`, `CAPTURE_PROCESSOR_NAME`, `MAX_RECORDING_MS`, `WORKER_INIT_TIMEOUT_MS`, `WORKER_CONTROL_TIMEOUT_MS`, `WORKER_FINISH_TIMEOUT_MS`, `createLocalVoiceDictationAdapter(platform?: LocalVoicePlatform): VoiceDictationAdapter`.

**Implementation — `src/lib/localVoiceDictation.ts` (complete file; Task 10 adds no further code to it, so it is written once here):**

```ts
import {
  voiceLevelFromSamples,
  type VoiceDictationAdapter,
  type VoiceDictationErrorCode,
  type VoiceDictationPrepareProgress,
} from './voiceDictationContract';
import {
  browserVoiceModelCacheDeps,
  isVoiceModelCached,
  loadVoiceModelPackage,
  VOICE_MODEL_BASE_URL,
  VOICE_MODEL_TOTAL_BYTES,
  type AbortControllerLike,
  type AbortSignalLike,
  type VoiceModelPackage,
} from './voiceModelCache';
// Type-only: erased by esbuild under isolatedModules, so none of the
// worker's code is pulled into the main bundle. Must stay `import type`.
import type {
  VoiceWorkerMessage,
  VoiceWorkerPartial,
  VoiceWorkerReply,
} from './voiceRecognitionWorker';

export interface MessagePortLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

/**
 * The whole microphone -> worklet -> destination graph behind one handle.
 * Collapsing it this way keeps every `new AudioWorkletNode`, `connect` and
 * `disconnect` call inside the browser factory below, where it is one
 * mechanical block, and leaves the ordering decisions this module makes
 * (measure before transfer, stop tracks before asking for the tail)
 * testable against a trivial fake.
 */
export interface VoiceCaptureGraph {
  readonly port: MessagePortLike;
  disconnect(): void;
}

export interface MediaStreamTrackLike { stop(): void }
export interface MediaStreamLike { getTracks(): MediaStreamTrackLike[] }

export interface LocalAudioContextLike {
  readonly sampleRate: number;
  addWorkletModule(url: string): Promise<void>;
  createCaptureGraph(stream: MediaStreamLike, processorName: string): VoiceCaptureGraph;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface VoiceWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(message: unknown, transfer?: unknown[]): void;
  terminate(): void;
}

export interface LocalVoiceModelAccess {
  isCached(): Promise<boolean>;
  load(options: {
    onProgress(progress: VoiceDictationPrepareProgress): void;
    signal: AbortSignalLike;
  }): Promise<VoiceModelPackage>;
}

export interface LocalVoicePlatform {
  createWorker: (() => VoiceWorkerLike) | null;
  createAudioContext: (() => LocalAudioContextLike) | null;
  getUserMedia: (() => Promise<MediaStreamLike>) | null;
  model: LocalVoiceModelAccess | null;
  createAbortController(): AbortControllerLike;
  captureProcessorUrl: string;
  engineScriptUrls: string[];
  modelBaseUrl: string;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const CAPTURE_PROCESSOR_NAME = 'voice-capture';

/** Product rule: one recording is hard-capped at ten minutes. */
export const MAX_RECORDING_MS = 600_000;

/**
 * Opening an 11 MB WASM module plus a 68 MB model is CPU-bound and can take
 * tens of seconds on a weak phone, so this watchdog is generous. It is
 * deliberately separate from the download, which has no deadline at all and
 * is governed only by whether bytes are still arriving.
 */
export const WORKER_INIT_TIMEOUT_MS = 60_000;

/** Acknowledging `start` is bookkeeping; 5 s matches the browser adapter. */
export const WORKER_CONTROL_TIMEOUT_MS = 5_000;

/**
 * `finish` drains the queue and then decodes one second of padding. The
 * queue caps the backlog at about two seconds of audio, so even a device
 * decoding at a quarter of real time finishes well inside this.
 */
export const WORKER_FINISH_TIMEOUT_MS = 30_000;

type StageName = 'preparing' | 'listening' | 'finishing';

interface PendingRequest {
  resolve(reply: VoiceWorkerReply): void;
  reject(error: Error): void;
  timeoutId: number;
}

interface StageError extends Error { voiceCode: VoiceDictationErrorCode }

function stageError(code: VoiceDictationErrorCode): StageError {
  const error = new Error(`local_voice_${code}`) as StageError;
  error.voiceCode = code;
  return error;
}

function codeFromError(error: unknown): VoiceDictationErrorCode {
  if (typeof error === 'object' && error !== null && 'voiceCode' in error) {
    return (error as StageError).voiceCode;
  }
  return 'prepare-failed';
}

function isPartial(message: VoiceWorkerMessage): message is VoiceWorkerPartial {
  return 'type' in message && message.type === 'partial';
}

function browserLocalVoicePlatform(): LocalVoicePlatform {
  const engineScriptUrls = [
    // Order matters: the wrapper defines createOnlineRecognizer, the glue
    // then initialises the runtime using the Module object already set up.
    '/voice-engine/sherpa-onnx-asr.js',
    '/voice-engine/sherpa-onnx-wasm-main-asr.js',
  ];

  if (typeof window === 'undefined') {
    return {
      createWorker: null,
      createAudioContext: null,
      getUserMedia: null,
      model: null,
      createAbortController: () => new AbortController() as unknown as AbortControllerLike,
      captureProcessorUrl: '',
      engineScriptUrls,
      modelBaseUrl: VOICE_MODEL_BASE_URL,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    };
  }

  const capable = typeof Worker !== 'undefined'
    && typeof AudioWorkletNode !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && typeof window.AudioContext !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia);

  const cacheDeps = browserVoiceModelCacheDeps();

  return {
    createWorker: capable
      ? () => {
        const real = new Worker(new URL('./voiceRecognitionWorker.ts', import.meta.url), {
          type: 'module',
        });
        const like: VoiceWorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage: (message, transfer) => real.postMessage(
            message,
            (transfer ?? []) as Transferable[],
          ),
          terminate: () => real.terminate(),
        };
        real.onmessage = (event) => like.onmessage?.({ data: event.data });
        real.onerror = (event) => like.onerror?.({ message: event.message });
        return like;
      }
      : null,
    createAudioContext: capable
      ? () => {
        const context = new AudioContext();
        const like: LocalAudioContextLike = {
          get sampleRate() { return context.sampleRate; },
          addWorkletModule: (url) => context.audioWorklet.addModule(url),
          createCaptureGraph(stream, processorName) {
            const node = new AudioWorkletNode(context, processorName);
            const source = context.createMediaStreamSource(stream as unknown as MediaStream);
            source.connect(node);
            // A worklet only runs while it is reachable from the
            // destination. This node never writes to its output buffer, so
            // the connection is silent and causes no echo.
            node.connect(context.destination);
            const port: MessagePortLike = {
              onmessage: null,
              close: () => node.port.close(),
            };
            node.port.onmessage = (event) => port.onmessage?.({ data: event.data });
            return {
              port,
              disconnect() {
                node.port.onmessage = null;
                source.disconnect();
                node.disconnect();
              },
            };
          },
          resume: () => context.resume(),
          close: () => context.close(),
        };
        return like;
      }
      : null,
    getUserMedia: capable
      ? async () => navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      }) as unknown as Promise<MediaStreamLike>
      : null,
    model: capable
      ? {
        isCached: () => isVoiceModelCached(cacheDeps),
        load: (options) => loadVoiceModelPackage(cacheDeps, options),
      }
      : null,
    createAbortController: () => new AbortController() as unknown as AbortControllerLike,
    // Vite's asset-import-meta-url plugin rewrites this to the emitted
    // asset URL in build and to the dev-server URL in dev; it is evaluated
    // only here, inside the real factory, so the Node test runner (which
    // always injects a fake platform) never touches it.
    captureProcessorUrl: new URL('./voiceCaptureProcessor.js', import.meta.url).href,
    engineScriptUrls,
    modelBaseUrl: VOICE_MODEL_BASE_URL,
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
}

export function createLocalVoiceDictationAdapter(
  platform: LocalVoicePlatform = browserLocalVoicePlatform(),
): VoiceDictationAdapter {
  const { createWorker, createAudioContext, getUserMedia, model } = platform;

  return {
    supported: createWorker !== null
      && createAudioContext !== null
      && getUserMedia !== null
      && model !== null,

    async start(callbacks) {
      if (!createWorker || !createAudioContext || !getUserMedia || !model) {
        throw new Error('voice_dictation_unsupported');
      }

      let active = true;
      let stopRequested = false;
      let stage: StageName = 'preparing';
      let worker: VoiceWorkerLike | null = null;
      let audioContext: LocalAudioContextLike | null = null;
      let stream: MediaStreamLike | null = null;
      let graph: VoiceCaptureGraph | null = null;
      let limitTimeoutId: number | null = null;
      let latestText = '';
      let requestSeq = 0;
      const pending = new Map<number, PendingRequest>();
      const download = platform.createAbortController();

      const settleAll = (error: Error) => {
        const entries = [...pending.values()];
        pending.clear();
        for (const entry of entries) {
          platform.clearTimeout(entry.timeoutId);
          entry.reject(error);
        }
      };

      const releaseCapture = () => {
        if (graph) {
          graph.port.onmessage = null;
          graph.disconnect();
        }
        graph = null;
        for (const track of stream?.getTracks() ?? []) track.stop();
        stream = null;
      };

      const cleanup = () => {
        if (!active) return;
        active = false;
        // An 83 MB fetch for a session nobody is waiting for is pure waste
        // of the person's bandwidth and battery.
        download.abort();
        if (limitTimeoutId !== null) platform.clearTimeout(limitTimeoutId);
        limitTimeoutId = null;
        settleAll(new Error('session_disposed'));
        releaseCapture();
        if (audioContext) void audioContext.close().catch(() => undefined);
        audioContext = null;
        if (worker) {
          worker.onmessage = null;
          worker.onerror = null;
          worker.terminate();
        }
        worker = null;
      };

      // cleanup() flips `active` first, so both of these are self-guarding
      // and report exactly once. A failure reports only onError: the
      // controller's own failure path disposes the session and supersedes
      // it, so a trailing onEnd would be ignored anyway.
      const stopWithError = (code: VoiceDictationErrorCode) => {
        if (!active) return;
        cleanup();
        callbacks.onError(code);
      };
      const endSession = () => {
        if (!active) return;
        cleanup();
        callbacks.onEnd();
      };

      const request = (
        message: Record<string, unknown>,
        timeoutMs: number,
        transfer?: unknown[],
      ): Promise<VoiceWorkerReply> => new Promise((resolve, reject) => {
        const current = worker;
        if (!current) { reject(new Error('worker_missing')); return; }
        requestSeq += 1;
        const id = requestSeq;
        const timeoutId = platform.setTimeout(() => {
          pending.delete(id);
          reject(new Error('worker_timeout'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeoutId });
        current.postMessage({ ...message, id }, transfer);
      });

      const startCapture = async () => {
        let nextStream: MediaStreamLike;
        try {
          nextStream = await getUserMedia();
        } catch {
          throw stageError('permission-denied');
        }
        if (!active) {
          for (const track of nextStream.getTracks()) track.stop();
          return;
        }
        stream = nextStream;

        let nextContext: LocalAudioContextLike;
        try {
          nextContext = createAudioContext();
          await nextContext.resume();
          await nextContext.addWorkletModule(platform.captureProcessorUrl);
        } catch {
          // A browser without AudioWorklet is out of scope by design; the
          // text chat is unaffected.
          throw stageError('unsupported');
        }
        if (!active) {
          void nextContext.close().catch(() => undefined);
          return;
        }
        audioContext = nextContext;

        try {
          await request({ type: 'start' }, WORKER_CONTROL_TIMEOUT_MS);
        } catch {
          throw stageError('recognition-failed');
        }
        if (!active) return;

        stage = 'listening';
        const nextGraph = nextContext.createCaptureGraph(nextStream, CAPTURE_PROCESSOR_NAME);
        graph = nextGraph;
        nextGraph.port.onmessage = (event) => {
          if (!active || graph !== nextGraph || stage !== 'listening') return;
          const samples = event.data as Float32Array;
          // Measure before posting: postMessage transfers the buffer and
          // leaves this view detached, so the level must be read first.
          callbacks.onLevel(voiceLevelFromSamples(samples));
          worker?.postMessage(
            { type: 'audio', sampleRate: nextContext.sampleRate, samples },
            [samples.buffer],
          );
        };

        limitTimeoutId = platform.setTimeout(() => {
          limitTimeoutId = null;
          void stopSession();
        }, MAX_RECORDING_MS);

        callbacks.onStart();
      };

      const prepare = async () => {
        try {
          let pkg: VoiceModelPackage;
          try {
            const cached = await model.isCached();
            if (!active) return;
            if (!cached) {
              // Opening at zero lets a progress bar appear immediately
              // rather than after the first body chunk.
              callbacks.onPrepareProgress({ loadedBytes: 0, totalBytes: VOICE_MODEL_TOTAL_BYTES });
            }
            pkg = await model.load({
              onProgress: (progress) => { if (active) callbacks.onPrepareProgress(progress); },
              signal: download.signal,
            });
          } catch {
            if (!active) return;
            throw stageError('prepare-failed');
          }
          if (!active) return;

          // Bytes are done; the engine still has to open the model, and that
          // has no progress of its own.
          callbacks.onPrepareProgress(null);
          try {
            await request(
              {
                type: 'load',
                dataBytes: pkg.dataBytes,
                wasmBytes: pkg.wasmBytes,
                modelBaseUrl: platform.modelBaseUrl,
                engineScriptUrls: platform.engineScriptUrls,
              },
              WORKER_INIT_TIMEOUT_MS,
              [pkg.dataBytes, pkg.wasmBytes],
            );
          } catch {
            if (!active) return;
            throw stageError('prepare-failed');
          }
          if (!active) return;

          await startCapture();
        } catch (error) {
          if (!active) return;
          stopWithError(codeFromError(error));
        }
      };

      async function stopSession(): Promise<void> {
        if (!active || stopRequested) return;
        stopRequested = true;

        if (stage === 'preparing') {
          // Nothing was recorded; abandon the download instead of letting it
          // run to completion for a session the person already cancelled.
          endSession();
          return;
        }

        stage = 'finishing';
        if (limitTimeoutId !== null) platform.clearTimeout(limitTimeoutId);
        limitTimeoutId = null;
        // Release the microphone before waiting on the tail: the recording
        // indicator should go out the moment Stop is pressed.
        releaseCapture();

        let text = latestText;
        try {
          const reply = await request({ type: 'finish' }, WORKER_FINISH_TIMEOUT_MS);
          if (typeof reply.text === 'string') text = reply.text;
        } catch {
          if (!active) return;
          // The engine never confirmed the tail. Keep the partial text the
          // person already watched appear rather than discarding it.
          text = latestText;
        }
        if (!active) return;

        if (!text) {
          stopWithError('no-speech');
          return;
        }
        callbacks.onTranscript({ finalText: text, interimText: '' });
        endSession();
      }

      const next = createWorker();
      worker = next;
      next.onmessage = (event) => {
        if (!active || worker !== next) return;
        const data = event.data as VoiceWorkerMessage;
        if (isPartial(data)) {
          latestText = data.text;
          // The worker's partial text is always the whole transcript so far,
          // so it goes out as interim and nothing is ever duplicated.
          callbacks.onTranscript({ finalText: '', interimText: data.text });
          return;
        }
        const entry = pending.get(data.id);
        if (!entry) return;
        platform.clearTimeout(entry.timeoutId);
        pending.delete(data.id);
        if (data.ok) entry.resolve(data);
        // data.error carries engine diagnostics and stays inside this
        // module; the caller only ever sees an allowlisted code.
        else entry.reject(new Error('worker_failed'));
      };
      next.onerror = () => {
        if (!active || worker !== next) return;
        settleAll(new Error('worker_crashed'));
        stopWithError(stage === 'preparing' ? 'prepare-failed' : 'recognition-failed');
      };

      callbacks.onPrepareProgress(null);
      void prepare();

      return {
        stop() { void stopSession(); },
        dispose() { cleanup(); },
      };
    },
  };
}
```

**Test — `src/lib/localVoiceDictation.cases.test.ts` (shared preamble, then the fake platform, then this task's nine cases; Task 10 appends to the same file):**

```ts
import type {
  VoiceDictationErrorCode,
  VoiceDictationPrepareProgress,
  VoiceRecognitionEvent,
} from './voiceDictationContract';
import { VOICE_MODEL_BASE_URL, VOICE_MODEL_TOTAL_BYTES, type VoiceModelPackage } from './voiceModelCache';
import {
  createLocalVoiceDictationAdapter,
  CAPTURE_PROCESSOR_NAME,
  MAX_RECORDING_MS,
  WORKER_CONTROL_TIMEOUT_MS,
  WORKER_FINISH_TIMEOUT_MS,
  WORKER_INIT_TIMEOUT_MS,
  type LocalVoicePlatform,
  type MessagePortLike,
  type VoiceCaptureGraph,
} from './localVoiceDictation';

interface Recorded {
  levels: number[];
  transcripts: VoiceRecognitionEvent[];
  prepare: Array<VoiceDictationPrepareProgress | null>;
  errors: VoiceDictationErrorCode[];
  starts: number;
  ends: number;
  order: string[];
}

function recorder() {
  const log: Recorded = {
    levels: [], transcripts: [], prepare: [], errors: [], starts: 0, ends: 0, order: [],
  };
  return {
    log,
    callbacks: {
      onStart() { log.starts += 1; log.order.push('start'); },
      onPrepareProgress(progress: VoiceDictationPrepareProgress | null) { log.prepare.push(progress); },
      onTranscript(event: VoiceRecognitionEvent) { log.transcripts.push(event); },
      onLevel(level: number) { log.levels.push(level); log.order.push('level'); },
      onError(code: VoiceDictationErrorCode) { log.errors.push(code); },
      onEnd() { log.ends += 1; },
    },
  };
}

function createFakePlatform(options: {
  capable?: boolean;
  cached?: boolean;
  loadRejects?: boolean;
  getUserMediaRejects?: boolean;
  workletRejects?: boolean;
} = {}) {
  let workerCalls = 0;
  let getUserMediaCalls = 0;
  let abortCalls = 0;
  let graphDisconnects = 0;
  let contextCloses = 0;
  let terminateCalls = 0;
  let addedModuleUrl: string | null = null;
  let graphProcessorName: string | null = null;
  const posted: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const track = { stopCalls: 0, stop() { this.stopCalls += 1; } };
  const stream = { getTracks: () => [track] };
  let progressSink: ((progress: VoiceDictationPrepareProgress) => void) | null = null;
  let releaseLoad: ((pkg: VoiceModelPackage) => void) | null = null;
  let rejectLoad: ((error: Error) => void) | null = null;
  let capturePort: MessagePortLike | null = null;
  let nextTimerId = 1;
  const timers = new Map<number, { callback: () => void; ms: number }>();

  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: { message?: string }) => void) | null,
    postMessage(message: unknown) {
      const record = message as Record<string, unknown>;
      posted.push(record);
      order.push(record.type === 'audio' ? 'post' : `post:${String(record.type)}`);
    },
    terminate() { terminateCalls += 1; },
  };

  const graph: VoiceCaptureGraph = {
    port: { onmessage: null, close() { /* nothing to close in the fake */ } },
    disconnect() { graphDisconnects += 1; },
  };

  const value: LocalVoicePlatform = {
    createWorker: options.capable === false ? null : () => { workerCalls += 1; return worker; },
    createAudioContext: options.capable === false ? null : () => ({
      sampleRate: 48_000,
      async addWorkletModule(url: string) {
        if (options.workletRejects) throw new Error('RAW_WORKLET_SENTINEL');
        addedModuleUrl = url;
      },
      createCaptureGraph(_stream, processorName) {
        graphProcessorName = processorName;
        capturePort = graph.port;
        return graph;
      },
      async resume() { /* already running in the fake */ },
      async close() { contextCloses += 1; },
    }),
    getUserMedia: options.capable === false ? null : async () => {
      getUserMediaCalls += 1;
      if (options.getUserMediaRejects) throw new Error('RAW_MEDIA_SENTINEL');
      return stream;
    },
    model: options.capable === false ? null : {
      isCached: async () => options.cached === true,
      load: (loadOptions) => {
        progressSink = loadOptions.onProgress;
        return new Promise<VoiceModelPackage>((resolve, reject) => {
          releaseLoad = resolve;
          rejectLoad = reject;
          if (options.loadRejects) reject(new Error('RAW_DOWNLOAD_SENTINEL'));
        });
      },
    },
    createAbortController: () => {
      const listeners: Array<() => void> = [];
      let aborted = false;
      return {
        signal: {
          get aborted() { return aborted; },
          addEventListener(_type: 'abort', listener: () => void) { listeners.push(listener); },
          removeEventListener() { /* nothing to detach in the fake */ },
        },
        abort() { abortCalls += 1; aborted = true; for (const listener of listeners) listener(); },
      };
    },
    captureProcessorUrl: 'blob:worklet',
    engineScriptUrls: [
      '/voice-engine/sherpa-onnx-asr.js',
      '/voice-engine/sherpa-onnx-wasm-main-asr.js',
    ],
    modelBaseUrl: VOICE_MODEL_BASE_URL,
    setTimeout(callback, ms) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };

  return {
    value,
    posted,
    order,
    track,
    get workerCalls() { return workerCalls; },
    get getUserMediaCalls() { return getUserMediaCalls; },
    get abortCalls() { return abortCalls; },
    get graphDisconnects() { return graphDisconnects; },
    get contextCloses() { return contextCloses; },
    get terminateCalls() { return terminateCalls; },
    get addedModuleUrl() { return addedModuleUrl; },
    get graphProcessorName() { return graphProcessorName; },
    emitProgress(loadedBytes: number) {
      progressSink?.({ loadedBytes, totalBytes: VOICE_MODEL_TOTAL_BYTES });
    },
    finishLoad() {
      releaseLoad?.({
        dataBytes: new ArrayBuffer(8),
        wasmBytes: new ArrayBuffer(4),
        fromCache: options.cached === true,
      });
    },
    failLoad() { rejectLoad?.(new Error('RAW_DOWNLOAD_SENTINEL')); },
    reply(reply: { id: number; ok: boolean; error?: string; text?: string }) {
      worker.onmessage?.({ data: reply });
    },
    emitPartial(text: string) { worker.onmessage?.({ data: { type: 'partial', text } }); },
    emitWorkerError() { worker.onerror?.({ message: 'RAW_WORKER_SENTINEL' }); },
    emitAudio(samples: Float32Array) { capturePort?.onmessage?.({ data: samples }); },
    lastRequestId(type: string) {
      const match = [...posted].reverse().find((message) => message.type === type);
      assert(match, `no ${type} request was posted`);
      return match.id as number;
    },
    fireTimersOfDuration(ms: number) {
      const matched = [...timers.entries()].filter(([, timer]) => timer.ms === ms);
      for (const [id] of matched) timers.delete(id);
      for (const [, timer] of matched) timer.callback();
    },
    get pendingTimerDurations() { return [...timers.values()].map((timer) => timer.ms); },
  };
}

/** Lets the adapter's own awaited microtasks run between assertions. */
async function settle(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

await runCase('reports unsupported without creating a worker or touching the microphone', () => {
  const platform = createFakePlatform({ capable: false });
  const adapter = createLocalVoiceDictationAdapter(platform.value);
  assertEqual(adapter.supported, false);
  assertEqual(platform.workerCalls, 0);
  assertEqual(platform.getUserMediaCalls, 0);
});

await runCase('enters preparing at once and reports byte progress while downloading', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  assertDeepEqual(sink.log.prepare[0], null, 'preparation is announced before anything is known');
  await settle();
  assertDeepEqual(
    sink.log.prepare[1],
    { loadedBytes: 0, totalBytes: VOICE_MODEL_TOTAL_BYTES },
    'a bar can appear immediately for a first download',
  );
  platform.emitProgress(1_000_000);
  assertDeepEqual(sink.log.prepare[2], { loadedBytes: 1_000_000, totalBytes: VOICE_MODEL_TOTAL_BYTES });
  assertEqual(sink.log.starts, 0, 'preparation is not listening');
  session.dispose();
});

await runCase('a cached package never claims a byte bar', async () => {
  const platform = createFakePlatform({ cached: true });
  const sink = recorder();
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  assert(
    sink.log.prepare.every((entry) => entry === null),
    'opening an already-downloaded model has no progress to show',
  );
  session.dispose();
});

await runCase('sends the model bytes, base URL and exact engine script URLs to the worker', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  const load = platform.posted.find((message) => message.type === 'load');
  assert(load, 'a load request was posted');
  assertEqual((load.dataBytes as ArrayBuffer).byteLength, 8);
  assertEqual((load.wasmBytes as ArrayBuffer).byteLength, 4);
  assertEqual(load.modelBaseUrl, 'https://staysee.ru/voice-model/83bbf6f-large-int8/');
  assertDeepEqual(load.engineScriptUrls, [
    '/voice-engine/sherpa-onnx-asr.js',
    '/voice-engine/sherpa-onnx-wasm-main-asr.js',
  ], 'the wrapper loads before the Emscripten runtime');
  assertDeepEqual(sink.log.prepare[sink.log.prepare.length - 1], null, 'the bar gives way to engine init');
  session.dispose();
});

await runCase('a download failure reports prepare-failed and never leaks the raw error', async () => {
  const platform = createFakePlatform({ loadRejects: true });
  const sink = recorder();
  await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  assertDeepEqual(sink.log.errors, ['prepare-failed']);
  assert(!JSON.stringify(sink.log).includes('RAW_DOWNLOAD_SENTINEL'), 'raw errors stay inside the module');
  assertEqual(platform.terminateCalls, 1, 'the worker is released');
});

await runCase('a worker that never acknowledges load fails after the init watchdog', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  assert(
    platform.pendingTimerDurations.includes(WORKER_INIT_TIMEOUT_MS),
    'engine init gets its own generous watchdog, separate from the download',
  );
  platform.fireTimersOfDuration(WORKER_INIT_TIMEOUT_MS);
  await settle();
  assertDeepEqual(sink.log.errors, ['prepare-failed']);
});

await runCase('a worker failure reply during preparation reports prepare-failed', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  platform.reply({ id: platform.lastRequestId('load'), ok: false, error: 'RAW_WORKER_SENTINEL' });
  await settle();
  assertDeepEqual(sink.log.errors, ['prepare-failed']);
  assert(!JSON.stringify(sink.log).includes('RAW_WORKER_SENTINEL'), 'engine diagnostics never surface');
});

await runCase('stop during preparing aborts the download and ends without an error', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.emitProgress(5_000_000);
  session.stop();
  assertEqual(platform.abortCalls, 1, 'the in-flight fetch is aborted, not left to finish');
  assertEqual(sink.log.ends, 1, 'cancelling is not a failure');
  assertDeepEqual(sink.log.errors, []);
  assertEqual(platform.terminateCalls, 1);
  platform.finishLoad();
  await settle();
  assertEqual(sink.log.starts, 0, 'a late download completion cannot start a cancelled session');
});

await runCase('dispose during preparing releases everything and ignores late replies', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  session.dispose();
  session.dispose();
  assertEqual(platform.abortCalls, 1, 'dispose is idempotent');
  assertEqual(platform.terminateCalls, 1);
  platform.finishLoad();
  platform.emitPartial('поздно');
  platform.reply({ id: 1, ok: true });
  await settle();
  assertDeepEqual(sink.log.transcripts, [], 'late worker messages are ignored');
  assertEqual(sink.log.ends, 0, 'a disposed session reports nothing');
});

await runCase('one adapter start creates exactly one worker', async () => {
  // Review Focus 2, in-tab half: nothing here may create a second engine.
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.emitProgress(1);
  platform.emitProgress(2);
  assertEqual(platform.workerCalls, 1);
  session.dispose();
});

console.log('localVoiceDictation.cases.test.ts — all passed');
```

**Run:** `npx tsx src/lib/localVoiceDictation.cases.test.ts`
**Expected before implementation:** FAIL — module not found.
**Commit:** `feat(voice): add the local dictation adapter preparation phase`

---

### Task 10: Local adapter — capture, transcript, stop and the ten-minute cap

**Files:**
- Modify: `src/lib/localVoiceDictation.cases.test.ts` (append cases)
- Verify: `src/lib/localVoiceDictation.ts` (written whole in Task 9; no further edits)

**Interfaces:**
- Consumes: everything Task 9 produced.
- Produces: no new exports.

**Note for the implementer:** Task 9's implementation file is already complete, so this task is purely the second half of its test suite. Write these cases, run them, and only touch `localVoiceDictation.ts` if one of them legitimately fails — in which case fix it there and say so in the commit body.

**Test — append to `src/lib/localVoiceDictation.cases.test.ts`, before the final `console.log`:**

```ts
/** Drives a fake session all the way to listening. */
async function startListening(platform: ReturnType<typeof createFakePlatform>, sink: ReturnType<typeof recorder>) {
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  platform.reply({ id: platform.lastRequestId('load'), ok: true });
  await settle();
  platform.reply({ id: platform.lastRequestId('start'), ok: true });
  await settle();
  return session;
}

await runCase('loads the worklet module and reports listening once capture is wired', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  assertEqual(platform.getUserMediaCalls, 1, 'one microphone stream for recognition and the level alike');
  assertEqual(platform.addedModuleUrl, 'blob:worklet', 'the AudioWorklet module is registered');
  assertEqual(platform.graphProcessorName, CAPTURE_PROCESSOR_NAME);
  assertEqual(sink.log.starts, 1, 'listening is announced only after capture is live');
  session.dispose();
});

await runCase('microphone refusal reports permission-denied without leaking the raw error', async () => {
  const platform = createFakePlatform({ getUserMediaRejects: true });
  const sink = recorder();
  await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  platform.reply({ id: platform.lastRequestId('load'), ok: true });
  await settle();
  assertDeepEqual(sink.log.errors, ['permission-denied']);
  assert(!JSON.stringify(sink.log).includes('RAW_MEDIA_SENTINEL'));
});

await runCase('a context without AudioWorklet reports unsupported', async () => {
  const platform = createFakePlatform({ workletRejects: true });
  const sink = recorder();
  await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  platform.reply({ id: platform.lastRequestId('load'), ok: true });
  await settle();
  assertDeepEqual(sink.log.errors, ['unsupported']);
  assert(!JSON.stringify(sink.log).includes('RAW_WORKLET_SENTINEL'));
  assertEqual(platform.contextCloses, 1, 'the audio context is released');
});

await runCase('captured audio is measured before its buffer is transferred to the worker', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  platform.order.length = 0;
  platform.emitAudio(new Float32Array([1, -1, 1, -1]));
  assertDeepEqual(platform.order, ['level', 'post'], 'postMessage detaches the view, so level comes first');
  assertEqual(sink.log.levels[sink.log.levels.length - 1], 1, 'the level is real, from the recognition stream');
  const audio = platform.posted[platform.posted.length - 1];
  assertEqual(audio.type, 'audio');
  assertEqual(audio.sampleRate, 48_000, 'the context rate travels with the samples');
  session.dispose();
});

await runCase('partial text is interim and the finish reply becomes the final text', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  platform.emitPartial('привет');
  platform.emitPartial('привет как дела');
  assertDeepEqual(sink.log.transcripts, [
    { finalText: '', interimText: 'привет' },
    { finalText: '', interimText: 'привет как дела' },
  ], 'cumulative partial text never duplicates');
  session.stop();
  await settle();
  platform.reply({ id: platform.lastRequestId('finish'), ok: true, text: 'привет как дела' });
  await settle();
  assertDeepEqual(
    sink.log.transcripts[sink.log.transcripts.length - 1],
    { finalText: 'привет как дела', interimText: '' },
  );
  assertEqual(sink.log.ends, 1);
});

await runCase('stop releases the microphone before waiting for the tail, and ends once', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  platform.emitPartial('текст');
  session.stop();
  session.stop();
  assertEqual(platform.track.stopCalls, 1, 'the recording indicator goes out immediately');
  assertEqual(platform.graphDisconnects, 1, 'the capture graph is torn down once');
  const finishRequests = platform.posted.filter((message) => message.type === 'finish');
  assertEqual(finishRequests.length, 1, 'a second stop is a no-op');
  await settle();
  platform.reply({ id: platform.lastRequestId('finish'), ok: true, text: 'текст' });
  await settle();
  assertEqual(sink.log.ends, 1);
});

await runCase('a ten-minute recording stops itself at the hard cap', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  await startListening(platform, sink);
  platform.emitPartial('долгая речь');
  assert(platform.pendingTimerDurations.includes(MAX_RECORDING_MS), 'the cap is armed when listening starts');
  assertEqual(MAX_RECORDING_MS, 600_000, 'ten minutes exactly');
  platform.fireTimersOfDuration(MAX_RECORDING_MS);
  await settle();
  assertEqual(platform.track.stopCalls, 1, 'the microphone is released automatically');
  platform.reply({ id: platform.lastRequestId('finish'), ok: true, text: 'долгая речь' });
  await settle();
  assertEqual(sink.log.ends, 1);
  assertDeepEqual(sink.log.errors, []);
});

await runCase('a finish the worker never answers keeps the partial text instead of losing it', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  platform.emitPartial('почти всё');
  session.stop();
  await settle();
  assert(platform.pendingTimerDurations.includes(WORKER_FINISH_TIMEOUT_MS), 'finish has its own watchdog');
  platform.fireTimersOfDuration(WORKER_FINISH_TIMEOUT_MS);
  await settle();
  assertDeepEqual(
    sink.log.transcripts[sink.log.transcripts.length - 1],
    { finalText: 'почти всё', interimText: '' },
    'the dictation the person already saw is kept',
  );
  assertEqual(sink.log.ends, 1);
  assertDeepEqual(sink.log.errors, []);
});

await runCase('silence reports no-speech and never advises another browser', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  session.stop();
  await settle();
  platform.reply({ id: platform.lastRequestId('finish'), ok: true, text: '' });
  await settle();
  assertDeepEqual(sink.log.errors, ['no-speech']);
  assert(
    !sink.log.errors.includes('connection-blocked'),
    'on-device recognition has no cloud service to be blocked from',
  );
});

await runCase('a worker that never acknowledges start reports recognition-failed', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  platform.reply({ id: platform.lastRequestId('load'), ok: true });
  await settle();
  assert(
    platform.pendingTimerDurations.includes(WORKER_CONTROL_TIMEOUT_MS),
    'a control message gets a short watchdog, not the download-sized one',
  );
  platform.fireTimersOfDuration(WORKER_CONTROL_TIMEOUT_MS);
  await settle();
  assertDeepEqual(sink.log.errors, ['recognition-failed']);
  assertEqual(sink.log.starts, 0);
});

await runCase('a worker crash while listening reports recognition-failed without diagnostics', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  await startListening(platform, sink);
  platform.emitWorkerError();
  assertDeepEqual(sink.log.errors, ['recognition-failed']);
  assert(!JSON.stringify(sink.log).includes('RAW_WORKER_SENTINEL'));
  assertEqual(platform.track.stopCalls, 1, 'the microphone is released on a crash');
  assertEqual(platform.terminateCalls, 1);
});

await runCase('dispose while listening releases graph, tracks, context and worker', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  session.dispose();
  assertEqual(platform.graphDisconnects, 1);
  assertEqual(platform.track.stopCalls, 1);
  assertEqual(platform.contextCloses, 1);
  assertEqual(platform.terminateCalls, 1);
  platform.emitAudio(new Float32Array([1, 1]));
  platform.emitPartial('поздно');
  assertEqual(sink.log.ends, 0, 'a disposed session reports nothing');
  assert(
    !sink.log.transcripts.some((event) => event.interimText === 'поздно'),
    'late capture and worker events are ignored',
  );
});

await runCase('the adapter only ever emits allowlisted, on-device-appropriate codes', async () => {
  const seen = new Set<VoiceDictationErrorCode>();
  for (const build of [
    () => createFakePlatform({ loadRejects: true }),
    () => createFakePlatform({ getUserMediaRejects: true }),
    () => createFakePlatform({ workletRejects: true }),
  ]) {
    const platform = build();
    const sink = recorder();
    await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
    await settle();
    platform.finishLoad();
    await settle();
    platform.reply({ id: 1, ok: true });
    await settle();
    for (const code of sink.log.errors) seen.add(code);
  }
  for (const code of seen) {
    assert(
      ['prepare-failed', 'permission-denied', 'unsupported', 'no-speech', 'recognition-failed'].includes(code),
      `unexpected error code from the on-device adapter: ${code}`,
    );
  }
  assert(!seen.has('connection-blocked'), 'there is no recognition service to be blocked from');
});
```

**Run:** `npx tsx src/lib/localVoiceDictation.cases.test.ts`
**Expected before writing the cases:** the file passes with only Task 9's cases; after adding these, any mismatch is a real defect in `localVoiceDictation.ts`.
**Commit:** `feat(voice): cover local dictation capture, stop and the ten-minute cap`

---

### Task 11: Whole-suite verification and build guards for the worker and worklet

**Files:**
- Modify: `scripts/verify-prod-bundle.mjs`

**Interfaces:**
- Consumes: Tasks 6–10.
- Produces: a production build that fails if the worker chunk or the worklet asset is missing.

- [ ] **Step 1: Add the worker and worklet guard to `scripts/verify-prod-bundle.mjs`**

Insert immediately after the `engineFiles` loop added in Task 6:

```js
/**
 * The recognition worker and the capture worklet are referenced only from
 * JS chunks, so scripts/smoke-built-site.mjs (which walks index.html) would
 * not notice either of them vanishing -- for instance if Vite's worker or
 * asset handling changes under a future upgrade. These two markers survive
 * minification: one is a string literal in the recognizer config, the other
 * is in a file Vite copies verbatim.
 */
const bundledAssets = fs.readdirSync(distAssets)
  .filter((name) => name.endsWith('.js'))
  .map((name) => fs.readFileSync(path.join(distAssets, name), 'utf8'));
const assetMarkers = [
  ['zipformer2', 'the recognition worker chunk'],
  ["registerProcessor('voice-capture'", 'the AudioWorklet capture processor'],
];
for (const [marker, description] of assetMarkers) {
  if (!bundledAssets.some((text) => text.includes(marker))) {
    console.error(`[verify-prod-bundle] ${description} is missing from dist/assets (looked for ${marker})`);
    process.exit(1);
  }
}
```

- [ ] **Step 2: Confirm the guard passes on a real build**

Run: `npm run build`
Expected: `[verify-prod-bundle] OK`, with no marker errors.

- [ ] **Step 3: Confirm the guard actually bites**

Run:
```bash
node -e "const fs=require('node:fs'),p=require('node:path');const d='dist/assets';const f=fs.readdirSync(d).find(n=>n.endsWith('.js')&&fs.readFileSync(p.join(d,n),'utf8').includes('registerProcessor(\'voice-capture\''));fs.renameSync(p.join(d,f),p.join(d,f+'.bak'));console.log('moved',f)" && node scripts/verify-prod-bundle.mjs; node -e "const fs=require('node:fs'),p=require('node:path');const d='dist/assets';const f=fs.readdirSync(d).find(n=>n.endsWith('.bak'));fs.renameSync(p.join(d,f),p.join(d,f.replace(/\.bak$/,'')));console.log('restored',f)"
```
Expected: the worklet marker error and a non-zero exit, then the file is restored.

- [ ] **Step 4: Run the whole verification set**

Run:
```bash
npm run typecheck && npm run lint && npm run test:offline && npm run build && npm run smoke:bundle
```
Expected: all five clean, with no new errors or warnings relative to the pre-branch baseline. `test:offline` must report the four new `.cases.test.ts` files among the frontend group and print a `PASS:` line for every case in this plan.

- [ ] **Step 5: Confirm the worklet and worker actually load in dev (the one thing no automated check here can prove)**

Run `npm run dev`, open the app, and in the browser console run:

```js
const ctx = new AudioContext();
await ctx.audioWorklet.addModule(
  document.querySelector('script[type=module]') && '/src/lib/voiceCaptureProcessor.js',
);
new AudioWorkletNode(ctx, 'voice-capture');
console.log('worklet ok');
const w = new Worker('/src/lib/voiceRecognitionWorker.ts?worker_file&type=module', { type: 'module' });
w.onerror = (e) => console.error('worker failed', e.message);
setTimeout(() => console.log('worker ok'), 500);
```

Expected: `worklet ok` and `worker ok` with no `Cannot use import statement outside a module` and no `importScripts is not defined`. If either fails, the `worker: { format: 'es' }` / `{ type: 'module' }` pairing from Task 6 and Task 9 is the thing to re-check — not the module structure. Record the result (and the browser version) in the commit body, since Part 2's integration depends on it.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-prod-bundle.mjs
git commit -m "chore(voice): guard the recognition worker and capture worklet in the production build"
```

---

## Handoff to Part 2 (chat integration) — not implemented here

Part 1 deliberately leaves these to the chat-integration plan, and each is a real obligation, not a nicety:

1. `src/hooks/useVoiceDictation.ts` still builds `createBrowserVoiceDictationAdapter()`. Part 2 switches that one line to `createLocalVoiceDictationAdapter()`.
2. **Copy that must change at the same time as that switch.** `voiceDictationErrorCopy('recognition-failed')` currently ends `«Попробуй Microsoft Edge»` and `'connection-blocked'` says `«…или попробуй Microsoft Edge»`. That advice only ever made sense for a browser API that did the recognition elsewhere. Part 1 does not touch these strings because `browserVoiceDictation.cases.test.ts` asserts them and the browser adapter is still the live one. The on-device adapter never emits `connection-blocked` (pinned by a test in Task 10), but it does emit `recognition-failed` for a genuine engine failure — so when Part 2 makes the local adapter live, `recognition-failed`'s copy must be rewritten with no browser advice in it.
3. The consent screen before any download (product rule 7), the `preparing` progress UI, and the retry affordance for `prepare-failed`.
4. A settings entry calling `deleteVoiceModelPackage(browserVoiceModelCacheDeps())` (product rule 8).
5. The Apache 2.0 licence notice for the model and the engine; `public/voice-engine/ORIGIN.md` is the in-repo record it should quote.
6. Confirming, by reading where limits are checked today, that voice input stays available under the existing tariff rules without any new restriction (design doc, "Тарифы и доступ").
7. A single `prepare-failed` code cannot distinguish "no disk space" from "network dropped" in the UI; Part 1's copy names both causes in one sentence, the way the existing `connection-blocked` copy does. If Part 2 wants separate messages, that is a contract change (a `prepareFailure` reason channel) and should be decided there — `VoiceModelPrepareError.reason` already carries `'storage-full' | 'network' | 'cancelled'` internally, so the information exists.

## Self-review (run before handing this plan over)

**Spec coverage.** Model/engine choice and the eight recognizer parameters → Task 8 (plus a grep step that pins them). File sizes and first-download total → Task 5. Audio never leaves the device → no module in this plan has a network path other than the two model URLs and the two local engine scripts. Russian only → no language parameter exists anywhere. 10-minute cap → Task 9/10. Contract extension exactly as the spec's "Контракт нужно расширить" section names it → Task 1. Adapter layers 1–4 → Tasks 9/10, 8, 7, 3. All seven "что нельзя переносить как есть" items → ScriptProcessor→AudioWorklet (Tasks 7, 9), unbounded queue→bounded (Tasks 4, 8), `.wasm` cached too (Task 5, via `Module.wasmBinary`), delete hook (Task 5 `deleteVoiceModelPackage`), quota handling (Task 5 `storage-full`), real cancellation (Task 9 `AbortController` + the stop-during-preparing test), the 120 s blanket timeout replaced by four separately justified ones (Task 5's progress-driven stall watchdog plus Task 9's 60 s/5 s/30 s). Checks 1–11 from the spec's «Проверки» each map to a named test; check 12 is Task 11. Product rules 7, 8 and the licence block are Part 2's, listed above. The hosting decision is taken as given and not re-opened.

**Placeholder scan.** No "TBD", "TODO", "later", "add error handling", "add validation", "similar to Task N", or test step without test code. Every `catch` block in this plan either maps to a named error code or carries a comment saying why swallowing is correct. The two files with no unit tests (Tasks 7, 8) each state why and carry concrete runnable verification instead.

**Type consistency.** `onPrepareProgress(progress: VoiceDictationPrepareProgress | null)` is spelled identically in Task 1's interface, Task 2's controller, Task 9's adapter and both test files. `VoiceModelPackage` has exactly `{ dataBytes, wasmBytes, fromCache }` in Task 5 and is consumed with those names in Task 9. `VoiceWorkerReply` is `{ id, ok, error?, text? }` in Task 8 and read with those names in Task 9. `createVoiceRecognitionQueue`/`VOICE_QUEUE_CAPACITY` in Task 4 match Task 8's import. `VoiceRecognizerLike` in Task 3 matches what Task 8's `createOnlineRecognizer` return value is typed as. `CAPTURE_PROCESSOR_NAME === 'voice-capture'` matches `registerProcessor('voice-capture', …)` in Task 7 and the `assetMarkers` string in Task 11. `AbortSignalLike`/`AbortControllerLike` are declared once, in Task 5, and imported by Task 9.

**Review Focus coverage.** Each of the five lines has a named test in the owning task: 1 → "a tab that slept mid-download re-arms instead of failing"; 2 → "a cache another tab filled mid-download is overwritten, not an error" plus "one adapter start creates exactly one worker" and "a second start while preparing reuses the in-flight session"; 3 → "a ten-minute flood never grows past capacity"; 4 → "the live model URLs and sizes are pinned exactly", "an HTTP 404 from a mistyped revision path fails as a prepare error", "a short body fails instead of reaching the engine"; 5 → "a missing Cache Storage still prepares, in memory".

**Issues found and fixed inline while reviewing.** (a) The spec's "specific cause" wording versus its own one-new-code instruction — resolved by naming both causes in the single Russian string, as `connection-blocked` already does, with the finer-grained option written up for Part 2. (b) The `recognition-failed` "Microsoft Edge" copy would be wrong for the on-device adapter but its string is asserted by an untouched test — resolved by pinning the local adapter's code allowlist here and handing the copy change to Part 2 with the exact strings. (c) `voiceLevelFromSamples` had no home in the brief's module list — placed in `voiceDictationContract.ts` beside `normalizeVoiceLevel`, since the on-device adapter measures amplitude from the very block it sends to the recognizer and there is no AnalyserNode to normalise from. (d) A `MediaStreamSourceLike` that had to `connect` to an `AudioWorkletNodeLike` could not be implemented against real DOM objects without leaking a native handle through the interface — collapsed into one `createCaptureGraph(stream, processorName)` method.
