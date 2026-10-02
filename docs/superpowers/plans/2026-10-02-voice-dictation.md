# StaySee Voice Dictation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add free Russian speech-to-text dictation to the StaySee chat composer with a calm live recording line, editable transcript, no automatic send, and no StaySee audio storage.

**Architecture:** Keep browser speech and microphone APIs behind an injected adapter, put session state and stale-event protection in a framework-independent controller, and expose that controller to `ChatScreen` through a thin React hook. Render the listening state in a focused component so the existing send/stop logic remains unchanged and future native mobile adapters can implement the same contract.

**Tech Stack:** React 18, TypeScript 5.5, Vite, Tailwind CSS, Lucide React, Web Speech API, MediaDevices/Web Audio, Node test runner through `tsx`.

**Spec:** `docs/superpowers/specs/2026-10-02-voice-dictation-design.md`

## Global Constraints

- Dictation language is exactly `ru-RU` in the first version.
- Recognized speech becomes an editable draft and is never sent automatically.
- Existing draft text is preserved and dictated text is appended with one separating space.
- StaySee must not store audio, serialize audio buffers, or upload audio to its own server.
- No paid transcription API, backend endpoint, database migration, analytics event, or new dependency.
- Dictation is unavailable while an AI response is being generated.
- A failed waveform stream must not prevent speech recognition; use the fallback animation.
- Stop all media tracks and release recognition, audio context, animation frames, timers, and handlers on stop, conversation change, unmount, send, and error.
- Ignore every event from a stopped or superseded session.
- Raw browser errors and device names must not reach UI or logs.
- Unsupported browsers retain the complete text-chat experience.
- Do not alter Memory V3, message persistence, AI transport, or current send/abort behavior.

## File Map

- Create `src/lib/voiceDictationContract.ts`: shared types, safe error copy, draft joining, time formatting, and waveform normalization.
- Create `src/lib/voiceDictationContract.cases.test.ts`: pure contract tests.
- Create `src/lib/browserVoiceDictation.ts`: injected Web Speech and Web Audio adapter; no React imports.
- Create `src/lib/browserVoiceDictation.cases.test.ts`: deterministic fake recognition/media/audio lifecycle tests.
- Create `src/lib/voiceDictationController.ts`: single-session state machine, subscription API, draft preview, timer, and stale-event protection.
- Create `src/lib/voiceDictationController.cases.test.ts`: controller behavior and cleanup tests.
- Create `src/hooks/useVoiceDictation.ts`: thin React ownership/subscription wrapper.
- Create `src/components/chat/VoiceDictationBar.tsx`: listening UI with accessible stop control and amplitude bars.
- Create `src/components/chat/VoiceDictationBar.cases.test.tsx`: component contract tests without DOM dependencies.
- Create `src/lib/chatVoiceIntegration.ts`: pure composer decisions for start/stop availability.
- Create `src/lib/chatVoiceIntegration.cases.test.ts`: composer integration decision tests.
- Modify `src/components/screens/ChatScreen.tsx`: mic button, controller integration, lifecycle stops, errors, and preserved send flow.
- Modify `src/index.css`: calm fallback waveform and reduced-motion rule.

---

### Task 1: Lock the shared dictation contract

**Files:**
- Create: `src/lib/voiceDictationContract.ts`
- Test: `src/lib/voiceDictationContract.cases.test.ts`

**Interfaces:**
- Consumes: no application state and no browser globals.
- Produces: `VoiceDictationPhase`, `VoiceDictationErrorCode`, `VoiceDictationSnapshot`, `VoiceRecognitionEvent`, `VoiceDictationAdapter`, `VoiceDictationSession`, `appendDictationToDraft`, `formatDictationDuration`, `normalizeVoiceLevel`, and `voiceDictationErrorCopy`.

- [ ] **Step 1: Write the failing pure contract test**

```ts
import {
  appendDictationToDraft,
  formatDictationDuration,
  normalizeVoiceLevel,
  voiceDictationErrorCopy,
} from './voiceDictationContract';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(appendDictationToDraft('', 'Привет') === 'Привет', 'empty draft accepts speech');
assert(appendDictationToDraft('Мне трудно', 'говорить') === 'Мне трудно говорить', 'one separator is added');
assert(appendDictationToDraft('Уже есть ', ' текст ') === 'Уже есть текст', 'boundary whitespace is normalized');
assert(appendDictationToDraft('Черновик', '') === 'Черновик', 'empty speech preserves draft');
assert(formatDictationDuration(0) === '0:00', 'zero duration');
assert(formatDictationDuration(65_000) === '1:05', 'minute duration');
assert(normalizeVoiceLevel(-1) === 0, 'level clamps low');
assert(normalizeVoiceLevel(0.4) === 0.4, 'level preserves range');
assert(normalizeVoiceLevel(2) === 1, 'level clamps high');
assert(voiceDictationErrorCopy('permission-denied').includes('Разреши доступ'), 'safe permission copy');
assert(!voiceDictationErrorCopy('recognition-failed').includes('NotAllowedError'), 'raw errors never leak');
```

- [ ] **Step 2: Run the test and verify the missing module RED**

Run: `npx tsx src/lib/voiceDictationContract.cases.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `voiceDictationContract`.

- [ ] **Step 3: Implement the exact public contract and pure helpers**

```ts
export type VoiceDictationPhase = 'idle' | 'starting' | 'listening' | 'stopping' | 'error';
export type VoiceDictationErrorCode =
  | 'permission-denied'
  | 'unsupported'
  | 'no-speech'
  | 'recognition-failed';

export interface VoiceRecognitionEvent {
  finalText: string;
  interimText: string;
}

export interface VoiceDictationSnapshot {
  supported: boolean;
  phase: VoiceDictationPhase;
  previewDraft: string;
  finalText: string;
  interimText: string;
  elapsedMs: number;
  level: number;
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

export function voiceDictationErrorCopy(code: VoiceDictationErrorCode): string {
  if (code === 'permission-denied') return 'Разреши доступ к микрофону в настройках браузера';
  if (code === 'unsupported') return 'В этом браузере голосовой ввод пока недоступен';
  if (code === 'no-speech') return 'Не удалось расслышать. Попробуй ещё раз';
  return 'Голосовой ввод прервался. Текст сохранён';
}
```

- [ ] **Step 4: Run the targeted test and typecheck**

Run: `npx tsx src/lib/voiceDictationContract.cases.test.ts`

Expected: PASS with no thrown assertion.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit the contract**

```bash
git add src/lib/voiceDictationContract.ts src/lib/voiceDictationContract.cases.test.ts
git commit -m "[agent] feat: define voice dictation contract"
```

---

### Task 2: Build the browser speech and waveform adapter

**Files:**
- Create: `src/lib/browserVoiceDictation.ts`
- Test: `src/lib/browserVoiceDictation.cases.test.ts`

**Interfaces:**
- Consumes: `VoiceDictationAdapter`, `VoiceDictationErrorCode`, and callback types from Task 1.
- Produces: `BrowserVoicePlatform` and `createBrowserVoiceDictationAdapter(platform?: BrowserVoicePlatform): VoiceDictationAdapter`.

- [ ] **Step 1: Write failing adapter tests with injected fakes**

Create fakes for recognition, media tracks, audio context, analyser, animation frames, and verify these cases in independent `test(...)` blocks from `node:test`:

```ts
test('reports unsupported without touching media devices', async () => {
  const platform = fakePlatform({ recognition: false });
  const adapter = createBrowserVoiceDictationAdapter(platform.value);
  assert.equal(adapter.supported, false);
  assert.equal(platform.getUserMediaCalls, 0);
});

test('starts one ru-RU recognition and emits final and interim text', async () => {
  const platform = fakePlatform();
  const events: VoiceRecognitionEvent[] = [];
  const session = await createBrowserVoiceDictationAdapter(platform.value).start(callbacks({
    onTranscript: (event) => events.push(event),
  }));
  assert.equal(platform.recognition.lang, 'ru-RU');
  assert.equal(platform.recognition.continuous, true);
  assert.equal(platform.recognition.interimResults, true);
  platform.emitResults([
    { text: 'Привет', final: true },
    { text: ' как дела', final: false },
  ]);
  assert.deepEqual(events.at(-1), { finalText: 'Привет', interimText: ' как дела' });
  session.dispose();
});

test('waveform failure does not stop recognition', async () => {
  const platform = fakePlatform({ getUserMediaRejects: true });
  await createBrowserVoiceDictationAdapter(platform.value).start(callbacks());
  assert.equal(platform.recognition.startCalls, 1);
});

test('dispose releases every resource and late browser events are ignored', async () => {
  const platform = fakePlatform();
  let transcriptCalls = 0;
  const session = await createBrowserVoiceDictationAdapter(platform.value).start(callbacks({
    onTranscript: () => { transcriptCalls += 1; },
  }));
  session.dispose();
  platform.emitResults([{ text: 'поздно', final: true }]);
  assert.equal(transcriptCalls, 0);
  assert.equal(platform.track.stopCalls, 1);
  assert.equal(platform.audioContext.closeCalls, 1);
  assert.equal(platform.cancelAnimationFrameCalls, 1);
  assert.equal(platform.recognition.abortCalls, 1);
});
```

Also cover permission denial mapping, `no-speech`, generic failures, natural `onend`, repeated `stop()`/`dispose()`, and absence of raw error strings in callbacks.

- [ ] **Step 2: Run the adapter test and verify RED**

Run: `npx tsx --test src/lib/browserVoiceDictation.cases.test.ts`

Expected: FAIL because `createBrowserVoiceDictationAdapter` does not exist.

- [ ] **Step 3: Implement an injected platform boundary**

Define only the browser surface the adapter needs:

```ts
export interface BrowserVoicePlatform {
  createRecognition: (() => SpeechRecognitionLike) | null;
  getUserMedia: (() => Promise<MediaStreamLike>) | null;
  createAudioContext: (() => AudioContextLike) | null;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
}
```

The default platform must feature-detect `window.SpeechRecognition` and `window.webkitSpeechRecognition` without evaluating either constructor at module import time. Set `lang = 'ru-RU'`, `continuous = true`, `interimResults = true`, parse results into cumulative final/interim strings, and map browser error names only to the four safe codes.

Start recognition directly from the user-triggered call. Start `getUserMedia` for visualization independently; catch its rejection and keep recognition alive. Read analyser bytes into a reusable `Uint8Array`, convert RMS to `0..1`, and send only the normalized number through `onLevel`.

Implement one idempotent cleanup path that nulls recognition handlers before aborting, cancels the frame, stops every stream track, closes the audio context, and marks the session inactive before any external callback.

- [ ] **Step 4: Run adapter tests, contract tests, and typecheck**

Run: `npx tsx --test src/lib/browserVoiceDictation.cases.test.ts`

Expected: all adapter cases PASS.

Run: `npx tsx src/lib/voiceDictationContract.cases.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit the browser adapter**

```bash
git add src/lib/browserVoiceDictation.ts src/lib/browserVoiceDictation.cases.test.ts
git commit -m "[agent] feat: add browser voice dictation adapter"
```

---

### Task 3: Add the single-session controller and React hook

**Files:**
- Create: `src/lib/voiceDictationController.ts`
- Create: `src/lib/voiceDictationController.cases.test.ts`
- Create: `src/hooks/useVoiceDictation.ts`

**Interfaces:**
- Consumes: `VoiceDictationAdapter`, `VoiceDictationSnapshot`, and `appendDictationToDraft` from Task 1; browser adapter factory from Task 2.
- Produces: `createVoiceDictationController(options)`, `VoiceDictationController`, and `useVoiceDictation(options)`.

- [ ] **Step 1: Write the controller RED tests**

```ts
test('rapid starts create one session and preview preserves the base draft', async () => {
  const adapter = deferredAdapter();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: fakeClock.value });
  const first = controller.start('Мне важно');
  const second = controller.start('не использовать');
  assert.equal(adapter.startCalls, 1);
  adapter.emitStart();
  adapter.emitTranscript({ finalText: 'сказать', interimText: ' это' });
  assert.equal(controller.getSnapshot().previewDraft, 'Мне важно сказать это');
  await Promise.all([first, second]);
});

test('superseded events cannot change the next session', async () => {
  const adapter = multiSessionAdapter();
  const controller = createVoiceDictationController({ adapter: adapter.value, clock: fakeClock().value });
  await controller.start('Первый');
  controller.stop();
  await controller.start('Второй');
  adapter.session(0).emitTranscript({ finalText: 'старый', interimText: '' });
  assert.equal(controller.getSnapshot().previewDraft, 'Второй');
});
```

Add cases for phase transitions, elapsed time, level updates, manual stop, natural end, safe errors, final text preservation, idempotent dispose, stop during `starting`, subscriber notification, and an unsupported adapter producing `errorCode: 'unsupported'` without calling `adapter.start()`.

- [ ] **Step 2: Run the controller test and verify RED**

Run: `npx tsx --test src/lib/voiceDictationController.cases.test.ts`

Expected: FAIL because the controller module is missing.

- [ ] **Step 3: Implement the controller**

Expose this exact shape:

```ts
export interface VoiceDictationController {
  getSnapshot(): VoiceDictationSnapshot;
  subscribe(listener: () => void): () => void;
  start(baseDraft: string): Promise<void>;
  stop(): void;
  clearError(): void;
  dispose(): void;
}

export function createVoiceDictationController(options: {
  adapter: VoiceDictationAdapter;
  clock?: {
    now(): number;
    setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
    clearInterval(id: ReturnType<typeof setInterval>): void;
  };
}): VoiceDictationController;
```

Use a monotonically increasing session token. Every adapter callback captures its token and returns immediately unless it equals the active token. `start()` must return the existing start promise while phase is `starting` or `listening`. Update `previewDraft` from the immutable base draft plus the latest final/interim text. On error, preserve the latest preview, clean the session, and set the safe `errorCode`.

- [ ] **Step 4: Add the thin React hook**

```ts
export function useVoiceDictation(options: {
  disabled: boolean;
  draft: string;
  onDraftChange(value: string): void;
  conversationId: string | null;
}): {
  snapshot: VoiceDictationSnapshot;
  start(): Promise<void>;
  stop(): void;
  clearError(): void;
};
```

Create the controller once with `useRef`, subscribe with `useSyncExternalStore`, and call `onDraftChange(snapshot.previewDraft)` only while a session owns a preview. Stop on `disabled === true` and whenever `conversationId` changes; dispose on unmount. Do not import `ChatScreen` or application contexts.

- [ ] **Step 5: Run controller tests and project static checks**

Run: `npx tsx --test src/lib/voiceDictationController.cases.test.ts`

Expected: all controller cases PASS.

Run: `npm run typecheck && npm run lint`

Expected: both commands exit 0 with no warnings.

- [ ] **Step 6: Commit the controller and hook**

```bash
git add src/lib/voiceDictationController.ts src/lib/voiceDictationController.cases.test.ts src/hooks/useVoiceDictation.ts
git commit -m "[agent] feat: manage voice dictation sessions"
```

---

### Task 4: Build the calm recording line

**Files:**
- Create: `src/components/chat/VoiceDictationBar.tsx`
- Test: `src/components/chat/VoiceDictationBar.cases.test.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `VoiceDictationSnapshot` and `formatDictationDuration` from Task 1 plus current theme class strings supplied as props.
- Produces: `VoiceDictationBar` with no browser API access and no application context dependency.

- [ ] **Step 1: Write the component contract RED test**

Call the hook-free component as a plain function and inspect the returned React element tree with a small recursive `findByProp` helper:

```tsx
const tree = VoiceDictationBar({
  elapsedMs: 65_000,
  level: 0.5,
  phase: 'listening',
  onStop,
  textClass: 'text-test',
  mutedClass: 'muted-test',
});

assert.equal(findByProp(tree, 'aria-label', 'Остановить голосовой ввод').props.type, 'button');
assert.equal(findText(tree, 'Слушаю…'), true);
assert.equal(findText(tree, '1:05'), true);
findByProp(tree, 'aria-label', 'Остановить голосовой ввод').props.onClick();
assert.equal(stopCalls, 1);
assert.equal(countByPropPrefix(tree, 'data-voice-bar', 'bar-'), 9);
```

Also assert `role="status"`, `aria-live="polite"`, a visible non-color label, and bar transforms derived only from normalized `level`.

- [ ] **Step 2: Run the component test and verify RED**

Run: `npx tsx --test src/components/chat/VoiceDictationBar.cases.test.tsx`

Expected: FAIL because the component is missing.

- [ ] **Step 3: Implement the recording bar**

Render a compact single row: active `Mic`, `Слушаю…`, nine narrow bars, duration, and a `Square` stop icon. Give the stop button at least `44px` touch area. Derive each bar height from the same normalized level plus a fixed symmetric multiplier so the line feels alive without random layout changes.

Use `data-voice-bar="bar-0"` through `bar-8` for deterministic tests. When the level is zero, apply `voice-wave-fallback` rather than creating timers inside the component.

- [ ] **Step 4: Add the fallback and reduced-motion CSS**

```css
@keyframes voiceWaveFallback {
  0%, 100% { transform: scaleY(0.35); opacity: 0.45; }
  50% { transform: scaleY(0.8); opacity: 0.8; }
}

.voice-wave-fallback {
  animation: voiceWaveFallback 1.6s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .voice-wave-fallback {
    animation: none;
    transform: scaleY(0.5);
  }
}
```

- [ ] **Step 5: Run component tests, typecheck, and lint**

Run: `npx tsx --test src/components/chat/VoiceDictationBar.cases.test.tsx`

Expected: PASS.

Run: `npm run typecheck && npm run lint`

Expected: both exit 0 with no warnings.

- [ ] **Step 6: Commit the visual component**

```bash
git add src/components/chat/VoiceDictationBar.tsx src/components/chat/VoiceDictationBar.cases.test.tsx src/index.css
git commit -m "[agent] feat: add voice recording line"
```

---

### Task 5: Integrate dictation into the chat composer

**Files:**
- Modify: `src/components/screens/ChatScreen.tsx:1-40`
- Modify: `src/components/screens/ChatScreen.tsx:115-180`
- Modify: `src/components/screens/ChatScreen.tsx:640-890`
- Modify: `src/components/screens/ChatScreen.tsx:1250-1305`
- Create: `src/lib/chatVoiceIntegration.cases.test.ts`

**Interfaces:**
- Consumes: `useVoiceDictation`, `VoiceDictationBar`, `voiceDictationErrorCopy`, and Lucide `Mic`.
- Produces: user-visible mic start, listening/stop row, transcript draft, and lifecycle stop integration in the existing composer.

- [ ] **Step 1: Write an integration contract RED test**

Create `src/lib/chatVoiceIntegration.ts` and test its two integration decisions rather than source-scanning JSX:

```ts
import { canStartVoiceDictation, shouldStopVoiceDictation } from './chatVoiceIntegration';

assert(canStartVoiceDictation({ sending: false, phase: 'idle' }), 'idle chat can start or show unsupported copy');
assert(!canStartVoiceDictation({ sending: true, phase: 'idle' }), 'sending blocks dictation');
assert(!canStartVoiceDictation({ sending: false, phase: 'starting' }), 'second start is unavailable');
assert(shouldStopVoiceDictation('listening'), 'send path stops active dictation');
assert(!shouldStopVoiceDictation('idle'), 'idle path is unchanged');
```

- [ ] **Step 2: Run the integration test and verify RED**

Run: `npx tsx src/lib/chatVoiceIntegration.cases.test.ts`

Expected: FAIL because the integration helpers are missing.

- [ ] **Step 3: Add hook ownership and lifecycle wiring to `ChatScreen`**

Instantiate the hook with:

```ts
const voice = useVoiceDictation({
  disabled: sending,
  draft: inputValue,
  onDraftChange: setInputValue,
  conversationId: currentConversation?.id ?? null,
});
```

At the beginning of `handleSend`, stop an active session before reading and trimming `inputValue`; preserve the existing send lock, optimistic message, streaming, persistence, and retry code unchanged. Conversation changes and unmount are already owned by the hook and must not be duplicated in the screen.

- [ ] **Step 4: Replace only the composer presentation branch**

When phase is `starting`, `listening`, or `stopping`, render `VoiceDictationBar` instead of the textarea/buttons. Otherwise render the current textarea, then:

1. a secondary mic button with `aria-label="Начать голосовой ввод"` when not sending;
2. the existing send button when not sending;
3. the existing AI stop button when sending.

The mic remains clickable in an unsupported browser. Its click calls `start()`, and the controller immediately sets `errorCode: 'unsupported'` without constructing recognition or requesting microphone access. This makes the limitation understandable on touch devices instead of relying on a disabled control or hover tooltip. Do not hide or repurpose the existing send and AI-stop controls.

Show `voiceDictationErrorCopy(errorCode)` in a separate `role="status"` line beside the existing `sendError`, then clear it on the next input change or next start. Never pass the raw adapter error into JSX or `console`.

- [ ] **Step 5: Verify targeted behavior and static safety**

Run: `npx tsx src/lib/chatVoiceIntegration.cases.test.ts`

Expected: PASS.

Run: `npx tsx --test src/lib/voiceDictationContract.cases.test.ts src/lib/browserVoiceDictation.cases.test.ts src/lib/voiceDictationController.cases.test.ts src/components/chat/VoiceDictationBar.cases.test.tsx`

Expected: all voice tests PASS.

Run: `npm run typecheck && npm run lint && npm run build`

Expected: all commands exit 0; production bundle verification passes.

- [ ] **Step 6: Commit chat integration**

```bash
git add src/components/screens/ChatScreen.tsx src/lib/chatVoiceIntegration.ts src/lib/chatVoiceIntegration.cases.test.ts
git commit -m "[agent] feat: integrate voice dictation into chat"
```

---

### Task 6: Complete offline, privacy, and real-browser verification

**Files:**
- Modify only if a verification failure exposes a defect in a file already listed above.
- Do not add backend, database, provider, or environment files.

**Interfaces:**
- Consumes: the complete voice feature from Tasks 1-5.
- Produces: release evidence and a branch ready for review.

- [ ] **Step 1: Run the complete automated gate**

Run: `npm run test:offline`

Expected: every test group passes with 0 failures.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run lint`

Expected: 0 errors and 0 warnings.

Run: `npm run build`

Expected: Vite build and `verify-prod-bundle.mjs` both pass.

Run: `npm run smoke:bundle`

Expected: smoke test passes.

- [ ] **Step 2: Run privacy and scope scans**

Run:

```bash
rg -n "fetch\(|supabase|process\.env|import\.meta\.env|localStorage|sessionStorage|MediaRecorder|Blob|FormData" src/lib/voiceDictationContract.ts src/lib/browserVoiceDictation.ts src/lib/voiceDictationController.ts src/hooks/useVoiceDictation.ts src/components/chat/VoiceDictationBar.tsx
```

Expected: no matches. Browser recognition may use its vendor service internally, but StaySee code contains no upload, storage, environment secret, recorder, or audio serialization path.

Run: `git diff origin/main...HEAD --check`

Expected: no whitespace errors.

- [ ] **Step 3: Perform the local real-browser checklist**

Start: `npm run dev -- --host 127.0.0.1`

On current desktop Chrome or Edge, verify:

1. Existing text plus dictated Russian text produces one correctly spaced draft.
2. Interim words appear while speaking and final words do not duplicate.
3. The line reacts to voice, timer advances, and stop returns to the editable textarea.
4. Nothing is sent until the ordinary send button is pressed.
5. Denying microphone permission preserves the draft and shows only the safe Russian message.
6. Switching conversations while listening turns off the browser microphone indicator.
7. Starting an AI response removes/disables dictation while the existing AI stop button still works.
8. Narrow mobile viewport keeps mic, send, timer, and stop controls tappable without horizontal overflow.
9. With reduced motion enabled, the fallback line is calm and static.
10. DevTools Network shows no StaySee audio/blob/form upload request.

- [ ] **Step 4: Review the final diff against every spec section**

Read the design spec and map Goal, Product Rules, UI, Architecture, States, Lifecycle, Accessibility, Compatibility, Tests, Exclusions, and Readiness Criterion to changed code or fresh verification evidence. If any item lacks evidence, do not create a PR; add the missing test or implementation and rerun Steps 1-3.

- [ ] **Step 5: Commit only a necessary verification fix**

If Step 1-4 required no source changes, do not create an empty commit. If a defect was fixed, stage only the affected voice files and use:

```bash
git commit -m "[agent] fix: complete voice dictation verification"
```

- [ ] **Step 6: Stop before integration**

Report exact test totals, static check results, browser/device used, privacy scan output, final `git status`, and commit list. Ordinary push/PR/merge/deploy may proceed under Nastya's standing authorization only after this evidence is complete. This feature makes no paid provider calls, so no paid-run approval is needed.
