# Voice Dictation Chat Integration (Part 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make StaySee's microphone button use the on-device recognition engine built in Part 1 — behind an explicit consent step before the first 83 MB download, with visible download progress, a way to delete the package again, and the Apache 2.0 notice that redistributing the engine requires.

**Architecture:** Every decision this feature makes lives in a small pure module that runs under `tsx` with no browser: which error sentence to show (`voiceDictationContract.ts`), how to phrase byte progress (`voiceDictationContract.ts`), which composer row to render (`chatVoiceIntegration.ts`), and whether a microphone press should ask or start (`voiceDownloadConsent.ts`). The two new React components are presentational — they take plain props and call those functions, and are tested by calling the component function and walking the returned element tree, exactly as `VoiceDictationBar.cases.test.ts` already does. `useVoiceDictation.ts` and `ChatScreen.tsx` are left as thin, mechanical wiring with no logic of their own, because this repository has no way to test either one.

**Tech Stack:** TypeScript 5.5 (strict, `isolatedModules`, `noUnusedLocals`, `noUnusedParameters`), React 18.3, Vite 5.4, Tailwind 3.4, `lucide-react` icons, Node test runner through `tsx` (`npm run test:offline`). No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-10-06-local-voice-dictation-design.md` (Part 1's plan and its handoff list: `docs/superpowers/plans/2026-10-06-local-voice-recognition-engine.md`)

## Global Constraints

- **Nothing downloads until the person has explicitly said yes.** `createLocalVoiceDictationAdapter().start()` calls `model.isCached()` and then `model.load(...)` with no consent check inside it — consent was scoped to this plan. Therefore `controller.start()` must not be called for an uncached package until the person has pressed «Скачать». Verified by reading `src/lib/localVoiceDictation.ts:403-421`.
- Recognition language is Russian only. Audio never leaves the device over the network at any stage.
- First download is 83,239,825 bytes (`VOICE_MODEL_TOTAL_BYTES`), shown to people as «83 МБ». Sizes are rendered in decimal megabytes (`bytes / 1_000_000`), not mebibytes, because the spec, Part 1's plan and the consent copy all promise «~83 МБ»; MiB would read 79 and look like a different number.
- The voice package must be deletable independently of the account, the conversations and every other piece of site data. Deletion is `deleteVoiceModelPackage(browserVoiceModelCacheDeps())`, which removes exactly one named cache (`staysee-voice-model-83bbf6f-large-int8`) and enumerates nothing.
- Raw engine errors, storage error names and device names must never reach the UI. The UI only ever renders `voiceDictationErrorCopy(code)`.
- **Tariffs and access are unaffected, and this is a stated fact, not an open question.** Limits are enforced entirely server-side: `supabase/functions/_shared/cost.ts:186-218` (`checkRateLimit` — reads `is_suspended` and `daily_request_limit` from `user_usage_tiers`) called by `supabase/functions/staysee-chat/index.ts`, which returns HTTP 429 at lines 564 and 620. The limit counts **AI chat requests**, i.e. messages actually sent. The only client-side contact with any of this is `fetchUsageTier` in `src/lib/usageTier.ts`, consumed in exactly one place — `src/components/screens/ProfileScreen.tsx:102-108` — purely to render the string «Free · сегодня N из M». Grep for `usageTier|fetchUsageTier|daily_request_limit|is_suspended` across `src/` returns only `usageTier.ts` and `ProfileScreen.tsx`. Voice dictation produces a draft in the textarea and nothing else; quota is consumed when the person presses Send, identically to typing. This plan adds no limit check, removes none, and creates no path that reaches the AI without going through the existing `handleSend`. Nothing here needs a tariff change.
- `browserVoiceDictation.ts` and `browserVoiceDictation.cases.test.ts` are **not** modified. After Task 7 nothing imports `createBrowserVoiceDictationAdapter`, so the browser adapter becomes unreachable at runtime; it and its 400-line test suite stay in the tree as the reference implementation of the contract and as the basis for any future non-WASM fallback. Deleting them is a separate decision, not this plan's.
- All new `.cases.test.ts` files use the in-file harness (`assert`/`assertEqual`/`assertDeepEqual`/`runCase`/`console.log('PASS: …')`) and are picked up automatically by `scripts/run-offline-tests.mjs`, which globs every `src/**/*.cases.test.ts`. Never import a test framework; there is none installed.
- No new npm dependency, no backend endpoint, no DB migration, no analytics event.

## Review Focus

1. **Somebody who already has the package but is asked anyway.** The cache probe (`isVoiceModelCached`) is asynchronous, so for the first few hundred milliseconds after the chat opens `packageCached` is `null`. A microphone press in that window shows a consent card for a download that will not happen. The decision function deliberately asks in the unknown case — one redundant question is the right way to fail, an unasked-for 83 MB download is not — but a reasonable person expects this never to be visible in practice. → pinned by the `packageCached: null` cases in Task 4; the real-world timing is verified by hand in Task 10's checklist item 2.
2. **Somebody who declines and later changes their mind.** «Отмена» must not be a one-way door: it is "not now", not "never". Nothing is persisted on decline, the microphone must become pressable again immediately, and pressing it must reopen the same card. → pinned by the "a decline leaves no trace" case in Task 4; the screen behavior is verified by hand in Task 10's checklist item 3.
3. **What the microphone looks like while the consent card is up, versus while actually recording.** These are three different states sharing one composer row: card open (textarea still usable, mic visibly disabled and `aria-expanded`), preparing (composer replaced by a progress row with a cancel button), recording (composer replaced by the existing waveform bar with a stop button). Getting the branch order wrong makes `VoiceDictationBar` render «Слушаю…» with a running timer during an 83 MB download, because its label only special-cases `'starting'` (`src/components/chat/VoiceDictationBar.tsx:31`). → pinned by the `voiceComposerMode` cases in Task 3 and the progress-row cases in Task 5; the branch order is verified by hand in Task 10's checklist items 4 and 5.
4. **A device where the local adapter is not supported at all** (no AudioWorklet, no WASM, no `getUserMedia`, or an insecure context). Such a person must never be offered an 83 MB download they cannot use: the press goes straight to `controller.start()`, which publishes `errorCode: 'unsupported'` and the honest sentence «В этом браузере голосовой ввод пока недоступен». Typing and sending must be completely unaffected. → pinned by the `supported: false` case in Task 4; verified by hand in Task 10's checklist item 7.
5. **The delete button pressed while a recording is running.** Navigating from chat to Конфиденциальность unmounts `ChatScreen` (`src/App.tsx:149-163` renders exactly one screen from a switch), and `useVoiceDictation`'s unmount cleanup already calls `controller.stop()` and then disposes, which terminates the worker and closes the AudioContext. So the two cannot overlap — but that is an argument, not evidence, and it must be confirmed rather than assumed; the engine would keep running from memory after its cache entries vanish, which would be a confusing half-state. → verified by hand in Task 10's checklist item 8.

## File Structure

**Modified**
- `src/lib/voiceDictationContract.ts` — rewrite the `recognition-failed` and `connection-blocked` copy for an on-device engine; add `formatVoicePackageSize` and `voicePrepareDisplay` beside the existing `formatDictationDuration`.
- `src/lib/voiceDictationContract.cases.test.ts` — flip the one assertion that pins «Microsoft Edge»; add copy and formatter cases.
- `src/lib/chatVoiceIntegration.ts` — add `voiceComposerMode`, the composer's three-way branch, beside the existing `canStartVoiceDictation`/`shouldStopVoiceDictation`.
- `src/lib/chatVoiceIntegration.cases.test.ts` — cases for it.
- `src/hooks/useVoiceDictation.ts` — swap `createBrowserVoiceDictationAdapter()` for `createLocalVoiceDictationAdapter()`; expose `packageCached`, `consentRemembered`, `rememberConsent`.
- `src/components/screens/ChatScreen.tsx` — consent card, three-way composer branch, microphone press handler.
- `src/components/screens/PrivacyScreen.tsx` — a «Голосовой ввод» section carrying the licence notice and the delete action.

**Created**
- `src/lib/voiceDownloadConsent.ts` + `.cases.test.ts` — the consent flag behind an injectable storage interface, and the pure ask-or-start decision.
- `src/components/chat/VoicePreparingBar.tsx` + `.cases.test.ts` — the preparing/progress composer row.
- `src/components/chat/VoiceDownloadConsent.tsx` + `.cases.test.ts` — the consent card above the composer.
- `src/content/legal/voiceEngineNotice.ts` + `.cases.test.ts` — the Apache 2.0 attribution text as data, following `src/content/legal/offer.ts`.

**Deliberately not touched:** `src/lib/localVoiceDictation.ts`, `src/lib/voiceModelCache.ts`, `src/lib/voiceRecognitionWorker.ts`, `src/lib/voiceCaptureProcessor.js`, `src/lib/voiceDictationController.ts`, `src/lib/voiceDictationLifecycle.ts`, `src/components/chat/VoiceDictationBar.tsx`, `src/lib/browserVoiceDictation.ts` and its test, `scripts/verify-prod-bundle.mjs`, `vite.config.ts`. The controller already drives the `preparing` phase and `prepareProgress` end to end; this plan only renders what is already in the snapshot.

## Verified environment facts (do not re-derive)

- `scripts/run-offline-tests.mjs` globs every `src/**/*.cases.test.ts` and runs them with `node <tsx> --test`. A new test file needs no registration. `npm run test:offline` runs the whole set.
- **React components are testable here, and there is a precedent.** `src/components/chat/VoiceDictationBar.cases.test.ts` (note: `.ts`, not `.tsx`) calls the component function directly and walks the returned element tree. I ran it: `✔ VoiceDictationBar.cases.test.ts — all passed`. It works because the root `tsconfig.json` is a solution file with `files: []` and no `compilerOptions`, so esbuild under `tsx` falls back to the **classic** JSX transform (`React.createElement`) rather than the `react-jsx` runtime that `tsconfig.app.json` configures for Vite. That is why the test must do `Object.assign(globalThis, { React })` **before** a dynamic `await import(...)` of the component. Copy that preamble verbatim; a static `import` of the component would evaluate before the assignment and fail.
- The copy string «Microsoft Edge» is asserted in exactly one place: `src/lib/voiceDictationContract.cases.test.ts:44-47`. `browserVoiceDictation.cases.test.ts` asserts only error *codes* (`['permission-denied', 'recognition-failed']`, `['connection-blocked']`, …) and never imports `voiceDictationErrorCopy`. Rewriting the copy cannot break it.
- The on-device adapter emits exactly these codes, pinned by an allowlist test at `src/lib/localVoiceDictation.cases.test.ts:600-612`: `prepare-failed`, `permission-denied`, `unsupported`, `no-speech`, `recognition-failed`. It never emits `connection-blocked`. It *does* emit `recognition-failed` (`localVoiceDictation.ts:376` when the worker will not acknowledge `start`, and `:525` on a worker crash while listening), which is why that sentence must change.
- `VoiceDictationAdapter.start`'s `onPrepareProgress` is **optional** in the live contract (`voiceDictationContract.ts:54`) — the live file differs from Part 1's plan snippet here. The controller supplies it unconditionally, so nothing in this plan is affected.
- `src/App.tsx:149-163` renders exactly one screen from a `switch`, so navigating away from chat unmounts `ChatScreen`, and `useVoiceDictation`'s `useEffect(() => () => controller.stop(), …)` plus the deferred disposer tear the session down.
- `src/components/screens/PrivacyScreen.tsx` renders for logged-out users too (`case 'privacy': return <PrivacyScreen />` has no `user` guard) and already contains a local `DeleteAction` component with an `idle | confirming | loading | done | error` state machine, used five times.
- `ConfirmDeleteButton.tsx` exists as a reusable two-step delete, but `PrivacyScreen`'s own `DeleteAction` is the pattern to match inside that screen — same row shape, same «Да, удалить» wording, same red styling.
- `.voice-wave-fallback` in `src/index.css:138-147` animates `scaleY` and is wrong for a progress bar. Use Tailwind's `animate-pulse` with the `motion-reduce:animate-none` variant, which matches the reduced-motion care the existing custom animation already takes.
- ESLint lints `**/*.{ts,tsx}` with `react-hooks` rules on. `tsconfig.app.json` has `noUnusedLocals` and `noUnusedParameters`, so an unused import is a build failure.
- Verification commands: `npm run test:offline`, `npm run typecheck`, `npm run lint`, `npm run build` (which also runs `scripts/verify-prod-bundle.mjs`), `npm run smoke:bundle`.

## Shared test preamble

Every new `.cases.test.ts` file for a **pure module** starts with exactly this block (the repo has no shared helper module; each test file defines its own copy). Where a task's test code is shown below, this preamble is assumed above it and must be typed in verbatim:

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

Every new `.cases.test.ts` file for a **React component** starts with exactly this block instead, copied from `src/components/chat/VoiceDictationBar.cases.test.ts`:

```ts
import React, { isValidElement, type ReactElement, type ReactNode } from 'react';

Object.assign(globalThis, { React });

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
```

The component itself is then loaded with `const { X } = await import('./X');` **after** that block, never with a static import.

---

### Task 1: Rewrite the error copy that still advises another browser

**Files:**
- Modify: `src/lib/voiceDictationContract.ts:95-115`
- Test: `src/lib/voiceDictationContract.cases.test.ts:44-51`

**Interfaces:**
- Consumes: nothing.
- Produces: `voiceDictationErrorCopy(code: VoiceDictationErrorCode): string` — unchanged signature, two changed strings.

**Why no second parameter and no new code.** The brief asked whether `voiceDictationErrorCopy` needs to know which adapter is live. It does not. After Task 7, nothing imports `createBrowserVoiceDictationAdapter`, so the only runtime producer of `recognition-failed` is the on-device adapter and the controller's own `.catch()`. The browser adapter's test file asserts codes, never copy, so it is untouched. One sentence per code remains correct and the function stays total over the union.

`connection-blocked` is rewritten too even though the on-device adapter never emits it (pinned by `localVoiceDictation.cases.test.ts:611`). Leaving a live string that says «не может подключиться к сервису распознавания речи» in a product whose entire premise is that audio never leaves the device would be a lie waiting to surface, and the function is total — the UI will render whatever code reaches it.

- [ ] **Step 1: Write the failing test**

In `src/lib/voiceDictationContract.cases.test.ts`, replace lines 44-47 (the assertion that currently reads `'failed browser points to the verified fallback'`) with the four assertions below. Leave lines 40-43 (`NotAllowedError`) and 48-51 (`блокировщики`) exactly as they are.

```ts
assert(
  !voiceDictationErrorCopy('recognition-failed').includes('Microsoft Edge'),
  'an on-device engine failure never advises another browser',
);
assert(
  voiceDictationErrorCopy('recognition-failed').includes('на этом устройстве'),
  'an on-device failure names the device, not a remote service',
);
assert(
  !voiceDictationErrorCopy('connection-blocked').includes('Microsoft Edge'),
  'a blocked package download never advises another browser',
);
assert(
  !voiceDictationErrorCopy('connection-blocked').includes('сервису распознавания'),
  'there is no recognition service to be blocked from any more',
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/lib/voiceDictationContract.cases.test.ts`
Expected: FAIL with `an on-device engine failure never advises another browser`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/voiceDictationContract.ts`, replace the last two branches of `voiceDictationErrorCopy` (lines 111-115) with:

```ts
  if (code === 'connection-blocked') {
    // The on-device adapter never emits this code -- there is no recognition
    // service to be blocked from. It is kept because the copy function is
    // total over the error union, and the one way something like it could
    // still happen is a blocker or VPN cutting off the package download.
    return 'Не получилось скачать голосовой пакет. Проверь блокировщики рекламы и приватности, VPN — и попробуй ещё раз';
  }
  // Recognition now happens inside this browser, on this device. The old
  // advice to try Microsoft Edge pointed at a different cloud provider,
  // which no longer exists anywhere in this path.
  return 'Голосовой ввод сорвался на этом устройстве. Попробуй ещё раз или набери текст руками';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/lib/voiceDictationContract.cases.test.ts`
Expected: `voiceDictationContract.cases.test.ts — all passed`

Then run `npm run test:offline` and confirm `browserVoiceDictation.cases.test.ts` still passes — it asserts codes only, so it must be unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/lib/voiceDictationContract.ts src/lib/voiceDictationContract.cases.test.ts
git commit -m "fix(voice): say what an on-device failure actually is instead of advising Edge"
```

---

### Task 2: Format the package size and the download progress

**Files:**
- Modify: `src/lib/voiceDictationContract.ts` (add after `formatDictationDuration`, line 72)
- Test: `src/lib/voiceDictationContract.cases.test.ts` (append before the final `console.log`)

**Interfaces:**
- Consumes: `VoiceDictationPrepareProgress` (already exported from the same file).
- Produces:
  - `formatVoicePackageSize(totalBytes: number): string` — e.g. `'83 МБ'`.
  - `interface VoicePrepareDisplay { label: string; detail: string; percent: number | null }`
  - `voicePrepareDisplay(progress: VoiceDictationPrepareProgress | null): VoicePrepareDisplay`

`percent === null` means indeterminate — the contract's own doc comment on `prepareProgress` says a `null` during preparation is "working, but with no byte progress to show", which the adapter sends when the bytes are in and the engine is opening the model (`localVoiceDictation.ts:426`). The component renders a pulsing full-width bar for that, not a 0% bar.

- [ ] **Step 1: Write the failing test**

Add `formatVoicePackageSize` and `voicePrepareDisplay` to the import list at the top of `src/lib/voiceDictationContract.cases.test.ts`, then append before the final `console.log`:

```ts
// 83_239_825 is VOICE_MODEL_TOTAL_BYTES. It is written out rather than
// imported because the contract module must not depend on the cache module.
assert(formatVoicePackageSize(83_239_825) === '83 МБ', 'the package reads as the promised 83 MB');
assert(formatVoicePackageSize(0) === '0 МБ', 'zero is zero, not an empty string');
assert(formatVoicePackageSize(-5) === '0 МБ', 'a nonsense size never renders as negative');

const indeterminate = voicePrepareDisplay(null);
assert(indeterminate.percent === null, 'no bytes to report means no bar to claim');
assert(indeterminate.detail === '', 'no bytes to report means no byte counter');
assert(
  indeterminate.label === 'Готовлю голосовой движок',
  'the indeterminate stage says what is happening instead of claiming a download',
);

const started = voicePrepareDisplay({ loadedBytes: 0, totalBytes: 83_239_825 });
assert(started.label === 'Скачиваю голосовой пакет', 'the download stage names the download');
assert(started.detail === '0 из 83 МБ', 'the counter is visible from the very first frame');
assert(started.percent === 0, 'a download that has not started is at zero, not at null');

assert(
  voicePrepareDisplay({ loadedBytes: 50, totalBytes: 200 }).percent === 25,
  'a quarter is twenty-five percent',
);
assert(
  voicePrepareDisplay({ loadedBytes: 199, totalBytes: 200 }).percent === 99,
  'almost finished never rounds up to a finished-looking hundred',
);
assert(
  voicePrepareDisplay({ loadedBytes: 90_000_000, totalBytes: 83_239_825 }).percent === 100,
  'a body longer than expected is clamped, never above a hundred',
);
assert(
  voicePrepareDisplay({ loadedBytes: 90_000_000, totalBytes: 83_239_825 }).detail === '83 из 83 МБ',
  'the counter is clamped to the total too',
);
assert(
  voicePrepareDisplay({ loadedBytes: 10, totalBytes: 0 }).percent === null,
  'a zero total is indeterminate, never a division by zero',
);
assert(
  voicePrepareDisplay({ loadedBytes: Number.NaN, totalBytes: 200 }).percent === 0,
  'a NaN byte count reads as nothing downloaded, not as NaN percent',
);
assert(
  voicePrepareDisplay({ loadedBytes: 41_000_000, totalBytes: 83_239_825 }).detail === '41 из 83 МБ',
  'real download numbers read in whole megabytes',
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/lib/voiceDictationContract.cases.test.ts`
Expected: FAIL — `formatVoicePackageSize` is not exported from `./voiceDictationContract`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/voiceDictationContract.ts`, insert directly after `formatDictationDuration` (after line 72):

```ts
/**
 * Decimal megabytes, not mebibytes. The design document, the consent copy
 * and every conversation about this feature say "~83 МБ"; 83,239,825 bytes
 * is 83 decimal MB but only 79 MiB, and a progress counter that disagreed
 * with the number the person agreed to would look like a different file.
 */
const BYTES_PER_MEGABYTE = 1_000_000;

function megabytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes / BYTES_PER_MEGABYTE);
}

export function formatVoicePackageSize(totalBytes: number): string {
  return `${megabytes(totalBytes)} МБ`;
}

export interface VoicePrepareDisplay {
  /** What is happening, in plain Russian. */
  label: string;
  /** `«41 из 83 МБ»`, or empty when there are no bytes to report. */
  detail: string;
  /** 0-100, or `null` for "working, with no progress to show". */
  percent: number | null;
}

/**
 * Turns the snapshot's `prepareProgress` into the three strings the
 * preparing row renders. A `null` progress is not an error and not zero
 * percent: it is the engine opening an already-downloaded model, which has
 * no byte progress of its own -- see the doc comment on
 * `VoiceDictationSnapshot.prepareProgress`.
 */
export function voicePrepareDisplay(
  progress: VoiceDictationPrepareProgress | null,
): VoicePrepareDisplay {
  if (
    progress === null
    || !Number.isFinite(progress.totalBytes)
    || progress.totalBytes <= 0
  ) {
    return { label: 'Готовлю голосовой движок', detail: '', percent: null };
  }
  const loaded = Number.isFinite(progress.loadedBytes) ? Math.max(0, progress.loadedBytes) : 0;
  const clamped = Math.min(loaded, progress.totalBytes);
  return {
    label: 'Скачиваю голосовой пакет',
    detail: `${megabytes(clamped)} из ${megabytes(progress.totalBytes)} МБ`,
    // Floored, so the bar can only read 100% when the last byte is in.
    percent: Math.floor((clamped / progress.totalBytes) * 100),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/lib/voiceDictationContract.cases.test.ts`
Expected: `voiceDictationContract.cases.test.ts — all passed`

- [ ] **Step 5: Commit**

```bash
git add src/lib/voiceDictationContract.ts src/lib/voiceDictationContract.cases.test.ts
git commit -m "feat(voice): format the package size and download progress for the chat UI"
```

---

### Task 3: Decide which composer row the chat shows

**Files:**
- Modify: `src/lib/chatVoiceIntegration.ts` (append after `shouldStopVoiceDictation`, line 17)
- Test: `src/lib/chatVoiceIntegration.cases.test.ts` (append before the final `console.log`)

**Interfaces:**
- Consumes: `VoiceDictationPhase` (already imported in the file).
- Produces: `type VoiceComposerMode = 'compose' | 'preparing' | 'recording'`, `voiceComposerMode(phase: VoiceDictationPhase): VoiceComposerMode`.

**Why `preparing` is its own mode rather than part of `recording`.** `shouldStopVoiceDictation('preparing')` is `true` (Part 1 made it so, correctly — a download is an active session that navigating away must cancel), and `ChatScreen` currently derives its composer swap from that same predicate. If left alone, an 83 MB download would render `VoiceDictationBar`, whose label is `phase === 'starting' ? 'Подготавливаю…' : 'Слушаю…'` — so it would say «Слушаю…» over a ticking 0:00 timer and a stop button, for minutes, while nothing is being recorded. A separate mode keeps `shouldStopVoiceDictation` correct for its own callers and gives the composer an honest third state.

**Why the composer is replaced during preparing rather than left usable.** The spec says the preparing progress should appear «без блокировки остального интерфейса чата». Keeping the textarea live during preparing sounds closer to that, but it creates a worse trap: the Send button would then be reachable mid-download, and `handleSend`'s first line (`if (shouldStopVoiceDictation(phase)) { voice.stop(); return; }`) would silently cancel the download; and if Send were allowed through instead, `useVoiceDictation({ disabled: sending })` would call `controller.stop()` the moment `sending` flipped true — cancelling it anyway, invisibly, after the person had just agreed to download 83 MB. Replacing the composer row, exactly as recording already does, removes that whole class of surprise. Scrolling, reading history, the header and navigation all stay live, which is the part of the chat interface the spec's sentence is about.

- [ ] **Step 1: Write the failing test**

Add `voiceComposerMode` to the import list at the top of `src/lib/chatVoiceIntegration.cases.test.ts`, then append before the final `console.log`:

```ts
assert(
  voiceComposerMode('preparing') === 'preparing',
  'an 83 MB download gets its own row, not the recording bar',
);
assert(
  voiceComposerMode('listening') === 'recording',
  'recording keeps the existing waveform bar',
);
assert(
  voiceComposerMode('starting') === 'recording',
  'the brief starting moment stays on the recording bar, as before',
);
assert(
  voiceComposerMode('stopping') === 'recording',
  'the bar stays up until the engine hands back the tail',
);
assert(
  voiceComposerMode('idle') === 'compose',
  'an idle chat is a text box',
);
assert(
  voiceComposerMode('error') === 'compose',
  'after a failure the person gets their text box back immediately',
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/lib/chatVoiceIntegration.cases.test.ts`
Expected: FAIL — `voiceComposerMode` is not exported from `./chatVoiceIntegration`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/chatVoiceIntegration.ts`, after `shouldStopVoiceDictation`:

```ts
/**
 * Which of the three things the composer row is right now.
 *
 * Deliberately not derived from `shouldStopVoiceDictation`: that predicate
 * answers "is there a session to stop", which is true during the package
 * download too. The composer needs a different answer there, because the
 * recording bar would claim to be listening while nothing is recorded.
 */
export type VoiceComposerMode = 'compose' | 'preparing' | 'recording';

export function voiceComposerMode(phase: VoiceDictationPhase): VoiceComposerMode {
  if (phase === 'preparing') return 'preparing';
  if (phase === 'starting' || phase === 'listening' || phase === 'stopping') {
    return 'recording';
  }
  return 'compose';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/lib/chatVoiceIntegration.cases.test.ts`
Expected: `chatVoiceIntegration.cases.test.ts — all passed`

- [ ] **Step 5: Commit**

```bash
git add src/lib/chatVoiceIntegration.ts src/lib/chatVoiceIntegration.cases.test.ts
git commit -m "feat(voice): give the package download its own composer mode"
```

---

### Task 4: Remember the download agreement, and decide whether to ask

**Files:**
- Create: `src/lib/voiceDownloadConsent.ts`
- Test: `src/lib/voiceDownloadConsent.cases.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VOICE_DOWNLOAD_CONSENT_KEY`, `interface VoiceConsentStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }`, `type VoiceDownloadDecision = 'start' | 'ask'`, `browserVoiceConsentStorage(): VoiceConsentStorage | null`, `hasVoiceDownloadConsent(storage: VoiceConsentStorage | null): boolean`, `rememberVoiceDownloadConsent(storage: VoiceConsentStorage | null): void`, `forgetVoiceDownloadConsent(storage: VoiceConsentStorage | null): void`, `voiceDownloadDecision(input: { supported: boolean; packageCached: boolean | null; consentRemembered: boolean }): VoiceDownloadDecision`.

**Design notes, decided here so no one has to re-litigate them.**

- **Storage is injected, not reached for.** `src/lib/privacyNotice.ts` calls `localStorage` directly and its test patches `globalThis.localStorage`. That works but leaks global state between test files. This module takes the storage as a parameter, the way `createBrowserVoiceDictationAdapter(platform)` and `createLocalVoiceDictationAdapter(platform)` take theirs, so every case runs against a plain `Map` with nothing global touched.
- **What a decline does.** Nothing is persisted. «Отмена» closes the card and leaves the microphone pressable; pressing it again reopens the same card. A decline is "not now", not "never" — persisting it would mean building a way to un-decline, and the only place that could live is the same settings screen the person has not visited. The cost of not persisting it is one extra card if they press the microphone again on purpose, which is exactly what they meant to do.
- **What `packageCached === null` means.** The cache probe has not answered yet. The decision is `'ask'`. Guessing `'start'` could cost an unasked-for 83 MB download; asking costs one redundant question that disappears as soon as the probe resolves.
- **Why an unsupported device gets `'start'`.** `controller.start()` checks `adapter.supported` first and publishes `errorCode: 'unsupported'` without touching the network (`voiceDictationController.ts:107-118`). Routing straight there gives the honest «В этом браузере голосовой ввод пока недоступен» instead of inviting someone to download 83 MB they cannot use.

- [ ] **Step 1: Write the failing test**

Create `src/lib/voiceDownloadConsent.cases.test.ts` — shared pure-module preamble, then:

```ts
import {
  browserVoiceConsentStorage,
  forgetVoiceDownloadConsent,
  hasVoiceDownloadConsent,
  rememberVoiceDownloadConsent,
  voiceDownloadDecision,
  VOICE_DOWNLOAD_CONSENT_KEY,
  type VoiceConsentStorage,
} from './voiceDownloadConsent';

function fakeStorage(): VoiceConsentStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
}

function hostileStorage(): VoiceConsentStorage {
  return {
    getItem() { throw new Error('RAW_STORAGE_SENTINEL'); },
    setItem() { throw new Error('RAW_STORAGE_SENTINEL'); },
    removeItem() { throw new Error('RAW_STORAGE_SENTINEL'); },
  };
}

await runCase('the storage key is pinned so a rename is a deliberate act', () => {
  assertEqual(VOICE_DOWNLOAD_CONSENT_KEY, 'staysee-voice-download-consent');
});

await runCase('a browser that has never agreed has not agreed', () => {
  const storage = fakeStorage();
  assertEqual(hasVoiceDownloadConsent(storage), false);
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: false, consentRemembered: false }),
    'ask',
  );
});

await runCase('agreeing is remembered and is not asked again', () => {
  const storage = fakeStorage();
  rememberVoiceDownloadConsent(storage);
  assertEqual(storage.entries.get(VOICE_DOWNLOAD_CONSENT_KEY), '1', 'the flag is written');
  assertEqual(hasVoiceDownloadConsent(storage), true);
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: false, consentRemembered: true }),
    'start',
  );
});

await runCase('forgetting puts the question back', () => {
  // Deleting the package in settings calls this. Without it the next press
  // of the microphone would start an 83 MB download with no question asked.
  const storage = fakeStorage();
  rememberVoiceDownloadConsent(storage);
  forgetVoiceDownloadConsent(storage);
  assertEqual(hasVoiceDownloadConsent(storage), false);
  assertEqual(storage.entries.has(VOICE_DOWNLOAD_CONSENT_KEY), false, 'no empty value is left behind');
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: false, consentRemembered: false }),
    'ask',
  );
});

await runCase('a decline leaves no trace, so trying again just asks again', () => {
  // Review Focus 2: declining is "not now", never "never". Nothing is
  // written on cancel, so the very next press reopens the same card.
  const storage = fakeStorage();
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: false, consentRemembered: false }),
    'ask',
  );
  assertEqual(storage.entries.size, 0, 'a decline writes nothing at all');
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: false, consentRemembered: false }),
    'ask',
    'and the second press asks again rather than going quiet',
  );
});

await runCase('a package already on the device is never asked about', () => {
  // Review Focus 1: somebody who already has the package -- from a dev
  // session, or from before the consent flag was cleared -- must not be
  // asked to agree to a download that is not going to happen.
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: true, consentRemembered: false }),
    'start',
  );
});

await runCase('an unfinished cache probe asks rather than guesses', () => {
  // Review Focus 1: `null` is "the probe has not answered". One redundant
  // question is the right way to be wrong; a silent 83 MB download is not.
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: null, consentRemembered: false }),
    'ask',
  );
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: null, consentRemembered: true }),
    'start',
    'but somebody who already agreed is not asked twice over a slow probe',
  );
});

await runCase('a device that cannot do this is not offered a download', () => {
  // Review Focus 4: the controller publishes `unsupported` without touching
  // the network, which is a far kinder answer than an 83 MB invitation.
  assertEqual(
    voiceDownloadDecision({ supported: false, packageCached: false, consentRemembered: false }),
    'start',
  );
  assertEqual(
    voiceDownloadDecision({ supported: false, packageCached: null, consentRemembered: false }),
    'start',
  );
});

await runCase('a browser with no storage at all still works, it just asks every time', () => {
  assertEqual(hasVoiceDownloadConsent(null), false);
  rememberVoiceDownloadConsent(null);
  forgetVoiceDownloadConsent(null);
  assertEqual(hasVoiceDownloadConsent(null), false, 'nothing was remembered, and nothing crashed');
});

await runCase('storage that throws on every call is treated as absent', () => {
  const storage = hostileStorage();
  assertEqual(hasVoiceDownloadConsent(storage), false);
  rememberVoiceDownloadConsent(storage);
  forgetVoiceDownloadConsent(storage);
  assertEqual(hasVoiceDownloadConsent(storage), false, 'a hardened browser asks again, it does not break');
});

await runCase('a stray value in the key is not an agreement', () => {
  const storage = fakeStorage();
  storage.entries.set(VOICE_DOWNLOAD_CONSENT_KEY, 'maybe');
  assertEqual(hasVoiceDownloadConsent(storage), false, 'only the exact flag counts as yes');
});

await runCase('the browser factory returns something or honestly returns null', () => {
  // Under the Node test runner there is no localStorage at all, so this is
  // the null branch; in a browser it is the Storage object. Either way it
  // must not throw at module level or during a render.
  const storage = browserVoiceConsentStorage();
  assert(storage === null || typeof storage.getItem === 'function', 'a usable storage or an honest null');
});

console.log('voiceDownloadConsent.cases.test.ts — all passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/lib/voiceDownloadConsent.cases.test.ts`
Expected: FAIL — cannot find module `./voiceDownloadConsent`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/voiceDownloadConsent.ts`:

```ts
/**
 * Whether this browser has already agreed to download the on-device voice
 * package, and whether pressing the microphone should ask first.
 *
 * Product rule 7: nothing downloads until the person has said yes. The
 * stored flag is a convenience -- it exists so somebody who already agreed
 * is not asked again on every visit. It is never a security boundary: the
 * only thing that actually prevents a download is that `controller.start()`
 * is not called until `voiceDownloadDecision` says `start`.
 *
 * Storage is injected rather than reached for, the same way
 * `createLocalVoiceDictationAdapter(platform)` takes its platform, so every
 * case in the test file runs against a plain Map with nothing global
 * touched.
 */

export const VOICE_DOWNLOAD_CONSENT_KEY = 'staysee-voice-download-consent';

export interface VoiceConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type VoiceDownloadDecision = 'start' | 'ask';

export function browserVoiceConsentStorage(): VoiceConsentStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Some hardened privacy modes throw on the property access itself, not
    // just on the call.
    return null;
  }
}

export function hasVoiceDownloadConsent(storage: VoiceConsentStorage | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(VOICE_DOWNLOAD_CONSENT_KEY) === '1';
  } catch {
    // Unreadable storage means we have no evidence of an agreement, and no
    // evidence is a no.
    return false;
  }
}

export function rememberVoiceDownloadConsent(storage: VoiceConsentStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(VOICE_DOWNLOAD_CONSENT_KEY, '1');
  } catch {
    // Full or blocked storage just means the person is asked again next
    // visit, which is the safe direction to fail in.
  }
}

export function forgetVoiceDownloadConsent(storage: VoiceConsentStorage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(VOICE_DOWNLOAD_CONSENT_KEY);
  } catch {
    // Same reasoning in the other direction: the worst case is one extra
    // confirmation, never a silent 83 MB download.
  }
}

/**
 * `ask` means show the consent card and call nothing. `start` means call
 * `controller.start()` directly.
 */
export function voiceDownloadDecision(input: {
  supported: boolean;
  /** `null` while the Cache Storage probe has not answered yet. */
  packageCached: boolean | null;
  consentRemembered: boolean;
}): VoiceDownloadDecision {
  // A device that cannot run the engine must not be invited to download it.
  // `controller.start()` checks `adapter.supported` before anything else and
  // publishes the honest `unsupported` error without touching the network.
  if (!input.supported) return 'start';
  // Nothing is going to download, so there is nothing to agree to.
  if (input.packageCached === true) return 'start';
  if (input.consentRemembered) return 'start';
  // Everything else -- not cached, or not yet known -- asks.
  return 'ask';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/lib/voiceDownloadConsent.cases.test.ts`
Expected: eleven `PASS:` lines and `voiceDownloadConsent.cases.test.ts — all passed`

- [ ] **Step 5: Commit**

```bash
git add src/lib/voiceDownloadConsent.ts src/lib/voiceDownloadConsent.cases.test.ts
git commit -m "feat(voice): remember the download agreement and decide when to ask"
```

---

### Task 5: The preparing row with download progress

**Files:**
- Create: `src/components/chat/VoicePreparingBar.tsx`
- Test: `src/components/chat/VoicePreparingBar.cases.test.ts`

**Interfaces:**
- Consumes: Task 2's `voicePrepareDisplay`, `VoiceDictationPrepareProgress`.
- Produces: `VoicePreparingBar(props: { progress: VoiceDictationPrepareProgress | null; onCancel(): void; textClass: string; mutedClass: string })`.

It takes `textClass`/`mutedClass` and no theme context, matching `VoiceDictationBar`'s prop shape one for one so `ChatScreen` passes the same two theme strings it already passes there.

- [ ] **Step 1: Write the failing test**

Create `src/components/chat/VoicePreparingBar.cases.test.ts` — React-component preamble, then:

```ts
const { VoicePreparingBar } = await import('./VoicePreparingBar');

let cancelCalls = 0;
const downloading = VoicePreparingBar({
  progress: { loadedBytes: 41_000_000, totalBytes: 83_239_825 },
  onCancel: () => { cancelCalls += 1; },
  textClass: 'text-test',
  mutedClass: 'muted-test',
});

const status = findByProp(downloading, 'role', 'status');
assert(status.props['aria-live'] === 'polite', 'the download is announced politely');
assert(includesText(downloading, 'Скачиваю голосовой пакет'), 'the row says what is happening');
assert(includesText(downloading, '41 из 83 МБ'), 'the byte counter is visible');

const bar = findByProp(downloading, 'role', 'progressbar');
assert(bar.props['aria-valuenow'] === 49, 'the bar reports the real percentage');
assert(bar.props['aria-valuemin'] === 0, 'the bar has a floor');
assert(bar.props['aria-valuemax'] === 100, 'the bar has a ceiling');
assert(bar.props['data-voice-progress'] === 'determinate', 'a byte download has a real bar');

const fill = findByProp(downloading, 'data-voice-progress-fill', 'fill');
assert(
  (fill.props.style as { width?: string } | undefined)?.width === '49%',
  'the fill width follows the percentage',
);

const cancel = findByProp(downloading, 'aria-label', 'Отменить загрузку голосового пакета');
assert(cancel.props.type === 'button', 'cancel is a button');
(cancel.props.onClick as () => void)();
assert(cancelCalls === 1, 'cancel handler called once');

const opening = VoicePreparingBar({
  progress: null,
  onCancel: () => undefined,
  textClass: 'text-test',
  mutedClass: 'muted-test',
});
assert(includesText(opening, 'Готовлю голосовой движок'), 'the indeterminate stage says so');
assert(
  !includesText(opening, 'МБ'),
  'an indeterminate stage never shows a byte counter it does not have',
);
const openingBar = findByProp(opening, 'role', 'progressbar');
assert(
  openingBar.props['aria-valuenow'] === undefined,
  'an indeterminate bar claims no value rather than claiming zero',
);
assert(
  openingBar.props['data-voice-progress'] === 'indeterminate',
  'the indeterminate state is marked for styling and for this test',
);
const openingFill = findByProp(opening, 'data-voice-progress-fill', 'fill');
assert(
  (openingFill.props.className as string).includes('animate-pulse'),
  'the indeterminate bar pulses instead of sitting at a dead zero',
);
assert(
  (openingFill.props.className as string).includes('motion-reduce:animate-none'),
  'reduced motion is respected, as the existing voice wave already does',
);

const startOfDownload = VoicePreparingBar({
  progress: { loadedBytes: 0, totalBytes: 83_239_825 },
  onCancel: () => undefined,
  textClass: 'text-test',
  mutedClass: 'muted-test',
});
assert(
  findByProp(startOfDownload, 'role', 'progressbar').props['aria-valuenow'] === 0,
  'a download that just opened reads zero, not indeterminate',
);
assert(includesText(startOfDownload, '0 из 83 МБ'), 'the counter is there from the first frame');

console.log('VoicePreparingBar.cases.test.ts — all passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/components/chat/VoicePreparingBar.cases.test.ts`
Expected: FAIL — cannot find module `./VoicePreparingBar`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/chat/VoicePreparingBar.tsx`:

```tsx
import { Download, X } from 'lucide-react';
import {
  voicePrepareDisplay,
  type VoiceDictationPrepareProgress,
} from '../../lib/voiceDictationContract';

/**
 * The composer row while the voice package is downloading or the engine is
 * opening. Sibling of VoiceDictationBar and deliberately shaped like it:
 * same height, same accent colour, same two theme-class props, same
 * trailing 11x11 control. The difference is what it says and what the
 * control does -- this one cancels a download, it does not stop a recording.
 */
export function VoicePreparingBar(props: {
  progress: VoiceDictationPrepareProgress | null;
  onCancel(): void;
  textClass: string;
  mutedClass: string;
}) {
  const { progress, onCancel, textClass, mutedClass } = props;
  const display = voicePrepareDisplay(progress);
  const indeterminate = display.percent === null;

  return (
    <div
      className="flex min-h-11 flex-1 items-center gap-3"
      role="status"
      aria-live="polite"
      aria-label="Готовится голосовой ввод"
    >
      <Download className="h-4 w-4 shrink-0 text-[#c9a96e]" strokeWidth={1.6} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className={`truncate text-sm font-light ${textClass}`}>{display.label}</span>
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-[#c9a96e]/15"
          data-voice-progress={indeterminate ? 'indeterminate' : 'determinate'}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={display.percent ?? undefined}
        >
          <span
            data-voice-progress-fill="fill"
            className={`block h-full rounded-full bg-[#c9a96e]/70 transition-[width] duration-200 ${
              indeterminate ? 'animate-pulse motion-reduce:animate-none' : ''
            }`}
            style={{ width: indeterminate ? '100%' : `${display.percent}%` }}
          />
        </div>
      </div>
      {display.detail && (
        <span className={`shrink-0 text-xs tabular-nums ${mutedClass}`}>{display.detail}</span>
      )}
      <button
        type="button"
        onClick={onCancel}
        aria-label="Отменить загрузку голосового пакета"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[#c9a96e]/25 bg-[#c9a96e]/8 transition-colors hover:bg-[#c9a96e]/14"
      >
        <X className="h-3.5 w-3.5 text-[#c9a96e]/90" strokeWidth={1.5} />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/components/chat/VoicePreparingBar.cases.test.ts`
Expected: `VoicePreparingBar.cases.test.ts — all passed`

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/VoicePreparingBar.tsx src/components/chat/VoicePreparingBar.cases.test.ts
git commit -m "feat(voice): show real download progress while the voice package arrives"
```

---

### Task 6: The consent card

**Files:**
- Create: `src/components/chat/VoiceDownloadConsent.tsx`
- Test: `src/components/chat/VoiceDownloadConsent.cases.test.ts`

**Interfaces:**
- Consumes: nothing (the size arrives as an already-formatted string, so the component stays free of the cache module).
- Produces: `VoiceDownloadConsent(props: { sizeLabel: string; onAccept(): void; onCancel(): void; borderClass: string; surfaceClass: string; textClass: string; mutedClass: string })`.

The markup mirrors the existing privacy-notice card at `ChatScreen.tsx:1205-1228` — a bordered, surface-filled row above the composer with an icon, a sentence and buttons. `role="group"` with an `aria-label` rather than `role="dialog"`: this is an inline card with no focus trap and no modal backdrop, and claiming to be a dialog would mislead a screen reader about how to escape it.

- [ ] **Step 1: Write the failing test**

Create `src/components/chat/VoiceDownloadConsent.cases.test.ts` — React-component preamble, then:

```ts
const { VoiceDownloadConsent } = await import('./VoiceDownloadConsent');

let accepts = 0;
let cancels = 0;
const tree = VoiceDownloadConsent({
  sizeLabel: '83 МБ',
  onAccept: () => { accepts += 1; },
  onCancel: () => { cancels += 1; },
  borderClass: 'border-test',
  surfaceClass: 'surface-test',
  textClass: 'text-test',
  mutedClass: 'muted-test',
});

const group = findByProp(tree, 'role', 'group');
assert(group.props['aria-live'] === 'polite', 'the card announces itself politely');
assert(
  group.props['aria-label'] === 'Загрузка голосового пакета',
  'the card names what it is about',
);

assert(includesText(tree, '83 МБ'), 'the size is stated before anything downloads');
assert(
  includesText(tree, 'один раз'),
  'the card promises this is a one-time download, which is the whole bargain',
);
assert(
  includesText(tree, 'не отправляется'),
  'the card states the privacy promise that justifies the download',
);

const download = findByProp(tree, 'aria-label', 'Скачать голосовой пакет');
assert(download.props.type === 'button', 'download is a button');
(download.props.onClick as () => void)();
assert(accepts === 1, 'download handler called once');
assert(cancels === 0, 'download does not also cancel');

const cancel = findByProp(tree, 'aria-label', 'Отказаться от загрузки голосового пакета');
assert(cancel.props.type === 'button', 'cancel is a button');
(cancel.props.onClick as () => void)();
assert(cancels === 1, 'cancel handler called once');
assert(accepts === 1, 'cancel does not also download');

assert(includesText(tree, 'Скачать'), 'the affirmative button is labelled in plain Russian');
assert(includesText(tree, 'Отмена'), 'the declining button is labelled in plain Russian');

console.log('VoiceDownloadConsent.cases.test.ts — all passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/components/chat/VoiceDownloadConsent.cases.test.ts`
Expected: FAIL — cannot find module `./VoiceDownloadConsent`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/chat/VoiceDownloadConsent.tsx`:

```tsx
import { Download } from 'lucide-react';

/**
 * Product rule 7: the person agrees to the ~83 MB download before anything
 * downloads. This card is the whole of that gate's visible half -- the
 * other half is that `controller.start()` is simply not called until
 * `onAccept` fires.
 *
 * Shaped after the privacy-notice card above the composer: a bordered row
 * with an icon, one sentence and its actions. It is `role="group"`, not
 * `role="dialog"` -- there is no focus trap and no backdrop, and saying
 * "dialog" would tell a screen reader to expect an escape route that does
 * not exist. The chat behind it stays readable and scrollable.
 */
export function VoiceDownloadConsent(props: {
  /** Already formatted, e.g. «83 МБ». */
  sizeLabel: string;
  onAccept(): void;
  onCancel(): void;
  borderClass: string;
  surfaceClass: string;
  textClass: string;
  mutedClass: string;
}) {
  const { sizeLabel, onAccept, onCancel, borderClass, surfaceClass, textClass, mutedClass } = props;

  return (
    <div
      className={`mb-3 rounded-xl border ${borderClass} ${surfaceClass} px-4 py-3 flex items-start gap-3`}
      role="group"
      aria-live="polite"
      aria-label="Загрузка голосового пакета"
    >
      <Download className="w-4 h-4 mt-0.5 shrink-0 text-[#c9a96e]" strokeWidth={1.5} />
      <div className="flex-1 min-w-0">
        <p className={`${textClass} text-xs font-light leading-relaxed`}>
          Речь распознаётся прямо здесь, на твоём устройстве — аудио никуда не отправляется.
        </p>
        <p className={`${mutedClass} text-xs font-light leading-relaxed mt-1.5`}>
          {`Для этого нужно один раз скачать голосовой пакет, около ${sizeLabel}. Потом он останется в браузере, и качать заново не придётся.`}
        </p>
        <div className="flex gap-2 mt-2.5">
          <button
            type="button"
            onClick={onAccept}
            aria-label="Скачать голосовой пакет"
            className="px-3 py-1.5 rounded-lg border border-[#c9a96e]/30 bg-[#c9a96e]/8 text-[#c9a96e]/90 text-xs font-light transition-colors duration-200 hover:bg-[#c9a96e]/14"
          >
            Скачать
          </button>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Отказаться от загрузки голосового пакета"
            className={`px-3 py-1.5 rounded-lg border text-xs font-light transition-colors duration-200 ${borderClass} ${mutedClass}`}
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/components/chat/VoiceDownloadConsent.cases.test.ts`
Expected: `VoiceDownloadConsent.cases.test.ts — all passed`

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/VoiceDownloadConsent.tsx src/components/chat/VoiceDownloadConsent.cases.test.ts
git commit -m "feat(voice): ask before downloading the 83 MB voice package"
```

---

### Task 7: Switch the microphone to the on-device engine, behind the consent gate

**Files:**
- Modify: `src/hooks/useVoiceDictation.ts` (whole file)
- Modify: `src/components/screens/ChatScreen.tsx:60-66` (imports), `:177-182` (hook call), `:904-909` (derived state), `:1285-1357` (composer block), plus one new `useEffect` and three new handlers

**Interfaces:**
- Consumes: Task 3's `voiceComposerMode`, Task 4's `voiceDownloadDecision`/`browserVoiceConsentStorage`/`hasVoiceDownloadConsent`/`rememberVoiceDownloadConsent`, Task 2's `formatVoicePackageSize`, Tasks 5 and 6's components, Part 1's `createLocalVoiceDictationAdapter`, `isVoiceModelCached`, `browserVoiceModelCacheDeps`, `VOICE_MODEL_TOTAL_BYTES`.
- Produces: `useVoiceDictation` now additionally returns `packageCached: boolean | null`, `consentRemembered: boolean`, `rememberConsent: () => void`.

**These two files must land in one commit.** A commit that swapped the adapter without the gate would start an 83 MB download on the first microphone press with no question asked, which is exactly what product rule 7 forbids. Anyone bisecting or reviewing task by task must never see that state.

**Why this task has no unit test, and what replaces it.** There is no React renderer, no jsdom and no hook-testing library in this repository — `package.json` has no testing library at all, and the one component test that exists works by calling a pure component function, which cannot be done to a hook or to a 1400-line screen. Part 1 hit the same wall for `voiceCaptureProcessor.js` and `voiceRecognitionWorker.ts` and answered it with build-level plus scripted manual verification; this task follows that precedent. Everything this task decides was already decided and tested in Tasks 1-6; what is left here is wiring, and it is verified by `npm run test:offline`, `npm run typecheck`, `npm run lint`, `npm run build`, and the hands-on script in Step 4.

- [ ] **Step 1: Replace `src/hooks/useVoiceDictation.ts` entirely**

```ts
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createLocalVoiceDictationAdapter } from '../lib/localVoiceDictation';
import {
  createVoiceDictationController,
  type VoiceDictationController,
} from '../lib/voiceDictationController';
import { shouldApplyVoiceSnapshot } from '../lib/chatVoiceIntegration';
import { createDeferredVoiceDisposer } from '../lib/voiceDictationLifecycle';
import { browserVoiceModelCacheDeps, isVoiceModelCached } from '../lib/voiceModelCache';
import {
  browserVoiceConsentStorage,
  hasVoiceDownloadConsent,
  rememberVoiceDownloadConsent,
} from '../lib/voiceDownloadConsent';

export function useVoiceDictation(options: {
  disabled: boolean;
  draft: string;
  onDraftChange(value: string): void;
  conversationId: string | null;
}) {
  const { disabled, draft, onDraftChange, conversationId } = options;
  const controllerRef = useRef<VoiceDictationController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createVoiceDictationController({
      adapter: createLocalVoiceDictationAdapter(),
    });
  }
  const controller = controllerRef.current;
  const disposerRef = useRef<ReturnType<typeof createDeferredVoiceDisposer> | null>(null);
  if (!disposerRef.current) {
    disposerRef.current = createDeferredVoiceDisposer({
      dispose: controller.dispose,
      schedule: (callback) => window.setTimeout(callback, 0),
      cancel: (id) => window.clearTimeout(id),
    });
  }
  const disposer = disposerRef.current;
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const previousSnapshotRef = useRef<typeof snapshot | null>(null);

  /**
   * `null` until the Cache Storage probe answers. The consent decision
   * treats `null` as "ask", so a slow probe can only ever cost one
   * redundant question -- never a download nobody agreed to.
   */
  const [packageCached, setPackageCached] = useState<boolean | null>(null);
  const [consentRemembered, setConsentRemembered] = useState(
    () => hasVoiceDownloadConsent(browserVoiceConsentStorage()),
  );

  useEffect(() => {
    let cancelled = false;
    // Probing before the microphone is ever pressed is the whole point:
    // somebody who already has the package must not be asked to agree to a
    // download that is not going to happen. `isVoiceModelCached` swallows
    // its own failures and answers `false`, so this never rejects.
    void isVoiceModelCached(browserVoiceModelCacheDeps()).then((cached) => {
      if (!cancelled) setPackageCached(cached);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (disabled) controller.stop();
  }, [controller, disabled]);

  useEffect(() => () => controller.stop(), [controller, conversationId]);
  useEffect(() => {
    disposer.mount();
    return () => disposer.unmount();
  }, [disposer]);

  useEffect(() => {
    const previous = previousSnapshotRef.current;
    previousSnapshotRef.current = snapshot;
    if (shouldApplyVoiceSnapshot({ previous, current: snapshot })) {
      onDraftChange(snapshot.previewDraft);
    }
  }, [onDraftChange, snapshot]);

  const start = useCallback(async () => {
    controller.clearError();
    await controller.start(draft);
  }, [controller, draft]);

  const rememberConsent = useCallback(() => {
    rememberVoiceDownloadConsent(browserVoiceConsentStorage());
    setConsentRemembered(true);
  }, []);

  return {
    snapshot,
    start,
    stop: controller.stop,
    clearError: controller.clearError,
    packageCached,
    consentRemembered,
    rememberConsent,
  };
}
```

- [ ] **Step 2: Wire `ChatScreen.tsx`**

**2a.** Replace the voice import block at lines 60-66 with:

```tsx
import { useVoiceDictation } from '../../hooks/useVoiceDictation';
import { VoiceDictationBar } from '../chat/VoiceDictationBar';
import { VoiceDownloadConsent } from '../chat/VoiceDownloadConsent';
import { VoicePreparingBar } from '../chat/VoicePreparingBar';
import {
  formatVoicePackageSize,
  voiceDictationErrorCopy,
} from '../../lib/voiceDictationContract';
import { VOICE_MODEL_TOTAL_BYTES } from '../../lib/voiceModelCache';
import { voiceDownloadDecision } from '../../lib/voiceDownloadConsent';
import {
  canStartVoiceDictation,
  shouldStopVoiceDictation,
  voiceComposerMode,
} from '../../lib/chatVoiceIntegration';
```

**2b.** Directly after the `const voice = useVoiceDictation({ … });` call that ends at line 182, add:

```tsx
  const [voiceConsentOpen, setVoiceConsentOpen] = useState(false);
```

**2c.** Replace line 906 (`const voiceActive = shouldStopVoiceDictation(voice.snapshot.phase);`) and the layout effect that follows it with:

```tsx
  const voiceActive = shouldStopVoiceDictation(voice.snapshot.phase);
  const voiceComposer = voiceComposerMode(voice.snapshot.phase);
  useLayoutEffect(() => {
    resizeChatComposer(inputRef.current);
  }, [inputValue, voiceActive]);

  // The card is a question about what to do next. Once a session is under
  // way, or once the chat is busy sending, there is no "next" left to ask
  // about, so the card closes itself rather than lingering over a composer
  // that has already moved on.
  useEffect(() => {
    if (sending || voiceComposer !== 'compose') setVoiceConsentOpen(false);
  }, [sending, voiceComposer]);

  function handleVoicePress() {
    const decision = voiceDownloadDecision({
      supported: voice.snapshot.supported,
      packageCached: voice.packageCached,
      consentRemembered: voice.consentRemembered,
    });
    if (decision === 'ask') {
      voice.clearError();
      setVoiceConsentOpen(true);
      return;
    }
    setVoiceConsentOpen(false);
    void voice.start();
  }

  function handleVoiceConsentAccept() {
    voice.rememberConsent();
    setVoiceConsentOpen(false);
    void voice.start();
  }

  function handleVoiceConsentCancel() {
    // Deliberately persists nothing. Declining is "not now", not "never":
    // the microphone stays pressable and the next press asks again.
    setVoiceConsentOpen(false);
  }
```

**2d.** Replace the whole block from line 1285 (the `{voice.snapshot.errorCode && (` paragraph) through line 1357 (the closing `</div>` of the input field) with:

```tsx
            {voice.snapshot.errorCode && (
              <p className={`text-xs font-light mb-2 px-1 ${theme.textMuted}`} role="status">
                {voiceDictationErrorCopy(voice.snapshot.errorCode)}
              </p>
            )}

            {voiceConsentOpen && voiceComposer === 'compose' && (
              <VoiceDownloadConsent
                sizeLabel={formatVoicePackageSize(VOICE_MODEL_TOTAL_BYTES)}
                onAccept={handleVoiceConsentAccept}
                onCancel={handleVoiceConsentCancel}
                borderClass={theme.border}
                surfaceClass={theme.surface}
                textClass={theme.textSecondary}
                mutedClass={theme.textMuted}
              />
            )}

            {/* Input field */}
            <div className={`flex items-end gap-3 rounded-xl px-4 py-3 border transition-colors duration-200 ${theme.inputBg} ${theme.inputBorder}`}>
              {voiceComposer === 'preparing' ? (
                <VoicePreparingBar
                  progress={voice.snapshot.prepareProgress}
                  onCancel={voice.stop}
                  textClass={theme.inputText}
                  mutedClass={theme.textMuted}
                />
              ) : voiceComposer === 'recording' ? (
                <VoiceDictationBar
                  elapsedMs={voice.snapshot.elapsedMs}
                  level={voice.snapshot.level}
                  phase={voice.snapshot.phase}
                  onStop={voice.stop}
                  textClass={theme.inputText}
                  mutedClass={theme.textMuted}
                />
              ) : (
                <>
                  <textarea
                    ref={inputRef}
                    value={inputValue}
                    onChange={handleInputChange}
                    placeholder="Напишите как есть…"
                    rows={1}
                    enterKeyHint="enter"
                    className={`chat-compose-input flex-1 bg-transparent outline-none resize-none font-light text-[15px] leading-relaxed ${theme.inputText} ${theme.inputPlaceholder}`}
                    style={{ maxHeight: '120px' }}
                  />
                  {!sending && (
                    <button
                      type="button"
                      onClick={handleVoicePress}
                      disabled={voiceConsentOpen || !canStartVoiceDictation({
                        sending,
                        phase: voice.snapshot.phase,
                      })}
                      aria-label="Начать голосовой ввод"
                      aria-expanded={voiceConsentOpen}
                      title={voice.snapshot.supported
                        ? 'Голосовой ввод'
                        : 'В этом браузере голосовой ввод пока недоступен'}
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-all duration-200 disabled:opacity-30 ${theme.surface} ${theme.surfaceHover}`}
                    >
                      <Mic className={`h-4 w-4 ${theme.textSecondary}`} strokeWidth={1.5} />
                    </button>
                  )}
                  {sending ? (
                    <button
                      type="button"
                      onClick={handleStop}
                      aria-label="Остановить ответ"
                      className={`shrink-0 p-1.5 rounded-lg transition-all duration-200 border border-[#c9a96e]/25 bg-[#c9a96e]/8 hover:bg-[#c9a96e]/14`}
                    >
                      <Square
                        className="w-3.5 h-3.5 text-[#c9a96e]/85"
                        strokeWidth={1.5}
                        fill="currentColor"
                      />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!inputValue.trim()}
                      aria-label="Отправить"
                      className={`shrink-0 p-1.5 rounded-lg transition-all duration-200 disabled:opacity-20 ${theme.surface} ${theme.surfaceHover}`}
                    >
                      <Send className={`w-4 h-4 ${theme.textSecondary}`} strokeWidth={1.5} />
                    </button>
                  )}
                </>
              )}
            </div>
```

Nothing else in `ChatScreen.tsx` changes. `handleSend`'s existing first line keeps `shouldStopVoiceDictation` and stays correct: during `preparing` the Send button is not rendered at all, so that branch is simply unreachable there, and during recording it behaves exactly as it does today.

- [ ] **Step 3: Run the automated checks**

```bash
npm run test:offline
npm run typecheck
npm run lint
npm run build
```

Expected: all four succeed. `npm run build` also runs `scripts/verify-prod-bundle.mjs`, which is what proves the worker, the worklet and the two vendored engine files are still emitted after the adapter became reachable from the entry graph.

- [ ] **Step 4: Verify by hand in a real browser**

Run `npm run dev`, open a chat, and confirm each line. Record the browser and version in the commit body.

1. Open DevTools → Application → Cache Storage and delete `staysee-voice-model-83bbf6f-large-int8` if present; in Console run `localStorage.removeItem('staysee-voice-download-consent')`; reload.
2. Press the microphone. **Expected:** the consent card appears above the composer, saying «около 83 МБ». The Network tab shows **no** request to `/voice-model/`. The textarea is still usable. The microphone button is visibly dimmed (`disabled:opacity-30`).
3. Press «Отмена». **Expected:** the card closes, the microphone is bright and pressable again, nothing was requested, and `localStorage.getItem('staysee-voice-download-consent')` is `null`.
4. Press the microphone again, then «Скачать». **Expected:** the composer row is replaced by the download row: «Скачиваю голосовой пакет», a counter climbing «N из 83 МБ», a filling bar, and an ✕ cancel button. Two requests appear in Network, for the `.data` and then the `.wasm`.
5. When the bytes finish, the row switches to «Готовлю голосовой движок» with a pulsing bar and no counter, and then to the recording bar («Слушаю…», waveform, timer, ■). **Expected:** at no point does the row say «Слушаю…» while bytes are still downloading.
6. Speak, press ■, confirm the recognised text lands in the textarea, press Send, confirm the message goes through normally.
7. Reload the page and press the microphone. **Expected:** recording starts immediately, with no consent card and no `/voice-model/` requests.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useVoiceDictation.ts src/components/screens/ChatScreen.tsx
git commit -m "feat(voice): switch the chat microphone to on-device recognition behind an explicit consent step"
```

---

### Task 8: The Apache 2.0 attribution text

**Files:**
- Create: `src/content/legal/voiceEngineNotice.ts`
- Test: `src/content/legal/voiceEngineNotice.cases.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface VoiceEngineCredit { title: string; detail: string; licence: string; url: string }`, `VOICE_ENGINE_NOTICE_TITLE: string`, `VOICE_ENGINE_NOTICE_BODY: string`, `VOICE_ENGINE_CREDITS: VoiceEngineCredit[]`, `VOICE_ENGINE_LICENCE_URL: string`, `VOICE_ENGINE_LICENCE_NOTE: string`.

Content lives in `src/content/legal/` beside `offer.ts`, which is the repository's existing home for screen-facing legal text, so the wording is reviewable in one place and `PrivacyScreen` stays presentational. The test exists because Apache 2.0 §4 makes this attribution a legal obligation, not a nicety: a future copy edit that quietly drops one of the two components, or the licence name, should fail the build rather than ship.

- [ ] **Step 1: Write the failing test**

Create `src/content/legal/voiceEngineNotice.cases.test.ts` — shared pure-module preamble, then:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/content/legal/voiceEngineNotice.cases.test.ts`
Expected: FAIL — cannot find module `./voiceEngineNotice`.

- [ ] **Step 3: Write minimal implementation**

Create `src/content/legal/voiceEngineNotice.ts`:

```ts
/**
 * Attribution for the two Apache-2.0 components behind on-device voice
 * dictation, as the licence requires when they are redistributed.
 *
 * The in-repository record is `public/voice-engine/ORIGIN.md`; this file is
 * the user-facing half of it, rendered in the Конфиденциальность screen.
 * If either component is ever replaced, update both files and the byte
 * counts in `scripts/verify-prod-bundle.mjs` together.
 */

export interface VoiceEngineCredit {
  title: string;
  detail: string;
  licence: string;
  url: string;
}

export const VOICE_ENGINE_NOTICE_TITLE = 'Распознавание речи на устройстве';

export const VOICE_ENGINE_NOTICE_BODY =
  'Речь распознаётся прямо в браузере, на твоём устройстве. Аудио не отправляется ни на какой сервер — ни наш, ни чужой. Для этого один раз скачивается голосовой пакет; он хранится в браузере отдельно от аккаунта, бесед и памяти.';

export const VOICE_ENGINE_CREDITS: VoiceEngineCredit[] = [
  {
    title: 'Модель распознавания речи',
    detail: 'alphacep/vosk-model-streaming-ru, ревизия 83bbf6f, вариант Large INT8',
    licence: 'Apache License 2.0',
    url: 'https://huggingface.co/alphacep/vosk-model-streaming-ru',
  },
  {
    title: 'Движок распознавания',
    detail: 'k2-fsa/sherpa-onnx v1.12.20, сборка WebAssembly SIMD',
    licence: 'Apache License 2.0',
    url: 'https://github.com/k2-fsa/sherpa-onnx',
  },
];

export const VOICE_ENGINE_LICENCE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';

export const VOICE_ENGINE_LICENCE_NOTE =
  'Оба компонента распространяются по лицензии Apache License 2.0 и используются без изменений. Полный текст лицензии: apache.org/licenses/LICENSE-2.0';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/content/legal/voiceEngineNotice.cases.test.ts`
Expected: `voiceEngineNotice.cases.test.ts — all passed`

- [ ] **Step 5: Commit**

```bash
git add src/content/legal/voiceEngineNotice.ts src/content/legal/voiceEngineNotice.cases.test.ts
git commit -m "feat(voice): add the Apache 2.0 notice for the speech model and engine"
```

---

### Task 9: The settings entry — licence notice and delete the package

**Files:**
- Modify: `src/components/screens/PrivacyScreen.tsx:5` (imports), `:111-115` (state), after `:212` (handler), after `:311` (new section)

**Interfaces:**
- Consumes: Task 8's notice constants, Task 4's `forgetVoiceDownloadConsent`/`browserVoiceConsentStorage`, Part 1's `deleteVoiceModelPackage`/`isVoiceModelCached`/`browserVoiceModelCacheDeps`.
- Produces: nothing other tasks depend on.

**Why `PrivacyScreen` and not `ProfileScreen` or `MemoryScreen`.** All three were read. `MemoryScreen` is a memory *viewer* whose delete buttons act on individual remembered items — the wrong scale and the wrong subject. `ProfileScreen` is the cabinet: theme, navigation rows, sign-out, delete-the-whole-account; its one destructive action requires a password, because it destroys an account. `PrivacyScreen` is literally titled «Конфиденциальность» / «Как мы бережём ваши данные», already owns a «Управление данными» section with five per-data-type delete actions driven by a local `DeleteAction` component, and — decisively — it renders for logged-out visitors too (`src/App.tsx:161` has no `user` guard). The voice package is per-browser data that has nothing to do with an account, so it belongs on the one screen that can offer to delete it without one.

**Why deleting the package also forgets the agreement.** Without it, the next microphone press would see `consentRemembered === true`, decide `'start'`, and begin an 83 MB download with no question — a hidden background download, which is exactly what product rule 7 forbids. Choosing to delete the package is a withdrawal of the agreement to have it.

- [ ] **Step 1: Add the imports**

Change line 5 of `src/components/screens/PrivacyScreen.tsx` from `import { useState } from 'react';` to:

```tsx
import { useEffect, useState } from 'react';
```

and add, after the existing `import { isLegacyMemoryCompatibilityEnabled } from '../../lib/memoryScreenMode';` line:

```tsx
import {
  browserVoiceModelCacheDeps,
  deleteVoiceModelPackage,
  isVoiceModelCached,
} from '../../lib/voiceModelCache';
import {
  browserVoiceConsentStorage,
  forgetVoiceDownloadConsent,
} from '../../lib/voiceDownloadConsent';
import {
  VOICE_ENGINE_CREDITS,
  VOICE_ENGINE_LICENCE_NOTE,
  VOICE_ENGINE_NOTICE_BODY,
  VOICE_ENGINE_NOTICE_TITLE,
} from '../../content/legal/voiceEngineNotice';
```

- [ ] **Step 2: Add the state and the handler**

After `const [deleteMemoryV3State, setDeleteMemoryV3State] = useState<DeleteState>('idle');` (line 115) add:

```tsx
  /** `null` until the Cache Storage probe answers. */
  const [voicePackagePresent, setVoicePackagePresent] = useState<boolean | null>(null);
  const [deleteVoiceState, setDeleteVoiceState] = useState<DeleteState>('idle');

  useEffect(() => {
    let cancelled = false;
    void isVoiceModelCached(browserVoiceModelCacheDeps()).then((cached) => {
      if (!cancelled) setVoicePackagePresent(cached);
    });
    return () => { cancelled = true; };
  }, []);
```

After `handleDeleteMemoryV3` ends (line 212) add:

```tsx
  async function handleDeleteVoicePackage() {
    // Deliberately no `if (!user) return;`, unlike every handler above: the
    // voice package is data in this browser, not data in an account, and
    // this screen is reachable without being signed in.
    if (deleteVoiceState === 'idle') {
      setDeleteVoiceState('confirming');
      return;
    }
    if (deleteVoiceState !== 'confirming') return;
    setDeleteVoiceState('loading');
    try {
      // Removes exactly one named cache and enumerates nothing, so the
      // account, the conversations, the memory and every other site cache
      // are untouched. A `false` return means there was nothing to remove
      // (no Cache Storage in this context) -- not a failure.
      await deleteVoiceModelPackage(browserVoiceModelCacheDeps());
      // Deleting the package withdraws the agreement to download it.
      // Without this, the next press of the microphone would start an 83 MB
      // download with no question asked.
      forgetVoiceDownloadConsent(browserVoiceConsentStorage());
      setVoicePackagePresent(false);
      setDeleteVoiceState('done');
    } catch {
      setDeleteVoiceState('error');
    }
  }
```

- [ ] **Step 3: Add the section**

Insert between the closing `</section>` of «Управление данными» (line 311) and the opening `<section className="mb-8">` of «Дисклеймер» (line 313):

```tsx
        <section className="mb-8">
          <p className={sectionLabel}>Голосовой ввод</p>

          <div className={`rounded-xl border ${theme.border} ${theme.surface} px-4 sm:px-5 py-3.5 mb-2.5`}>
            <p className={`${theme.textPrimary} text-sm font-light mb-1.5`}>
              {VOICE_ENGINE_NOTICE_TITLE}
            </p>
            <p className={`${theme.textSecondary} text-[13px] font-light leading-[1.75] opacity-85 mb-3`}>
              {VOICE_ENGINE_NOTICE_BODY}
            </p>

            <div className="space-y-2.5">
              {VOICE_ENGINE_CREDITS.map((credit) => (
                <div key={credit.title}>
                  <p className={`${theme.textSecondary} text-xs font-light`}>{credit.title}</p>
                  <p className={`${theme.textMuted} text-xs font-light leading-relaxed`}>
                    {`${credit.detail} · ${credit.licence}`}
                  </p>
                  <a
                    href={credit.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={`${ACCENT_TEXT_CLASS} text-xs font-light underline underline-offset-2 break-all`}
                  >
                    {credit.url}
                  </a>
                </div>
              ))}
            </div>

            <p className={`${theme.textMuted} text-[11px] font-light leading-relaxed opacity-70 mt-3`}>
              {VOICE_ENGINE_LICENCE_NOTE}
            </p>
          </div>

          {voicePackagePresent === true ? (
            <DeleteAction
              title="Удалить голосовой пакет"
              description="Удалит скачанный пакет распознавания речи из этого браузера. Аккаунт, беседы и память не затрагиваются. Перед следующей загрузкой мы снова спросим согласие."
              doneText="Голосовой пакет удалён."
              state={deleteVoiceState}
              onStart={handleDeleteVoicePackage}
              onCancel={() => setDeleteVoiceState('idle')}
              onConfirm={handleDeleteVoicePackage}
            />
          ) : voicePackagePresent === false ? (
            <p className={`${theme.textMuted} text-xs font-light px-1`}>
              Голосовой пакет не скачан — удалять нечего.
            </p>
          ) : null}
        </section>
```

- [ ] **Step 4: Verify**

```bash
npm run test:offline
npm run typecheck
npm run lint
npm run build
```

Expected: all four succeed.

Then by hand, with `npm run dev`:

1. With the package downloaded (do Task 7's Step 4 first if needed), open Профиль → Документы → Конфиденциальность. **Expected:** a «Голосовой ввод» section with both credits, both links, both «Apache License 2.0», and a red «Удалить» button.
2. Press «Удалить» → «Да, удалить». **Expected:** «Голосовой пакет удалён.»; in DevTools → Application → Cache Storage, `staysee-voice-model-83bbf6f-large-int8` is gone while every other cache remains; in Console, `localStorage.getItem('staysee-voice-download-consent')` is `null`; conversations and memory are untouched.
3. Reload Конфиденциальность. **Expected:** «Голосовой пакет не скачан — удалять нечего.» and no delete button.
4. Go back to a chat and press the microphone. **Expected:** the consent card appears again. This is the whole point of forgetting the flag.
5. Sign out, then open Конфиденциальность from the registration screen. **Expected:** the section renders and the delete action works without an account.

- [ ] **Step 5: Commit**

```bash
git add src/components/screens/PrivacyScreen.tsx
git commit -m "feat(voice): let people delete the voice package and read its licences in settings"
```

---

### Task 10: Whole-feature verification

**Files:** none modified. This task produces the evidence that the feature is done, in the form of a commit message body.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Run every automated gate**

```bash
npm run test:offline
npm run typecheck
npm run lint
npm run build
npm run smoke:bundle
```

Expected: all five succeed, with no new warnings relative to the baseline at commit `0ca3860`. If anything fails, fix it before continuing; do not record a pass you did not see.

- [ ] **Step 2: Work through the spec's «Проверки» list by hand**

Run `npm run dev`. Record the browser and version. Each line names what to do and what must happen.

1. **First download, then reuse.** Clear the cache and the consent key; press the microphone; agree; let it finish and record something. Reload. Press the microphone. **Expected:** recording starts with no card and no `/voice-model/` request in Network.
2. **The probe beats the press.** With the package cached and `localStorage.removeItem('staysee-voice-download-consent')`, reload and press the microphone at a normal speed. **Expected:** no consent card — the probe has already answered `true`. *(Review Focus 1.)*
3. **Declining, then changing your mind.** Clear the cache and the key; press the microphone; press «Отмена»; press the microphone again. **Expected:** the card reappears, the microphone was never dead, and nothing downloaded in between. *(Review Focus 2.)*
4. **The microphone while the card is up.** With the card open, look at the microphone. **Expected:** visibly dimmed and unclickable, the textarea still types, the chat still scrolls. *(Review Focus 3.)*
5. **The microphone while downloading and while recording.** **Expected:** during the download the composer row is the progress row with ✕, never the waveform, and never the word «Слушаю…»; during recording it is the waveform with ■. *(Review Focus 3.)*
6. **Interrupting a download.** Start a download, press ✕ at around 20%. **Expected:** the composer comes back immediately, Network shows the request cancelled, and the microphone is pressable. Press it: because the agreement is remembered, it restarts the download without re-asking.
7. **An unsupported device.** In DevTools Console before loading the chat, run `Object.defineProperty(window, 'AudioWorkletNode', { value: undefined })`, then open a chat and press the microphone. **Expected:** no consent card, no network request, and the message «В этом браузере голосовой ввод пока недоступен». Typing and sending work completely normally. *(Review Focus 4.)*
8. **Delete while a recording is running.** Start recording, then navigate to Профиль → Документы → Конфиденциальность without stopping. **Expected:** the recording ends on its own at unmount; the voice section loads; the delete action works; returning to the chat leaves the draft intact and nothing crashed. *(Review Focus 5.)*
9. **Microphone permission refused.** Block microphone access for the site and press the microphone with the package already cached. **Expected:** «Разреши доступ к микрофону в настройках браузера».
10. **Stop, cancel, record again in a row.** Three recordings back to back. **Expected:** each produces text, each appends to the draft without erasing what is there, and the package is never re-downloaded.
11. **The draft survives.** Type something, dictate, confirm the dictation is appended rather than replacing it; send; confirm the textarea clears and no late recognition event puts the sent text back.
12. **The ten-minute cap.** Start a recording and leave it. **Expected:** it stops on its own at 10:00 and the text lands in the draft.
13. **Deletion is surgical.** After a delete: conversations, memory, theme choice and sign-in are all still there, and only the one cache entry is gone.

- [ ] **Step 3: Commit the record**

```bash
git commit --allow-empty -m "chore(voice): verify chat integration end to end

Automated: test:offline, typecheck, lint, build (incl. verify-prod-bundle),
smoke:bundle -- all green, no new warnings against 0ca3860.

Manual: the design document's 13 checks plus all five Review Focus cases,
performed in <browser> <version> on <OS>.

Mobile browsers were not tested in this pass and are therefore recorded as
unverified, not as supported -- the design document asks for exactly this
distinction in the final report."
```

---

## Self-review

**1. Spec coverage.** Product rule 7 (explicit consent before any download) → Tasks 4, 6, 7, with the gate's two halves named in Global Constraints. Rule 8 (deletable independently) → Task 9. The preparing progress UI and the `prepare-failed` retry affordance → Tasks 2, 5, 7 (the error paragraph already renders `voiceDictationErrorCopy('prepare-failed')`, whose text names both causes, and `canStartVoiceDictation` already permits a retry from the `error` phase, so retry is "press the microphone again" with no new control). «Попробуй Microsoft Edge» removed from the paths that are now on-device → Task 1. The licence block → Tasks 8 and 9. «Тарифы и доступ» → investigated and stated as fact in Global Constraints with file and line references, not left as a question. The spec's «Проверки» list → Task 10's numbered checklist, one line per check. The one-line adapter switch → Task 7. All seven items of Part 1's handoff punch list are covered: (1) Task 7, (2) Task 1, (3) Tasks 4/5/6/7, (4) Task 9, (5) Tasks 8/9 quoting `ORIGIN.md`, (6) Global Constraints, (7) addressed below.

Handoff item 7 — whether to split `prepare-failed` into separate "no disk space" and "network dropped" messages — is **declined here, deliberately**. `VoiceModelPrepareError.reason` carries the distinction internally, but surfacing it would mean a contract change (a new reason channel through the adapter, the controller and the snapshot) landing in the same plan as the adapter switch. Part 1's single sentence already names both causes the way the existing `connection-blocked` copy names its own, and a person's action is the same either way: free some space, check the connection, try again. If the finer distinction is ever wanted, it is its own small plan against the existing `reason` field.

**2. Placeholder scan.** No "TBD", "TODO", "later", "add error handling", "add validation", "similar to Task N", or test step without test code. Every `catch` in this plan carries a comment saying why swallowing is correct and what the person experiences instead. The two tasks with no unit test (7 and 9) each say why in a named paragraph and carry a numbered hands-on script with explicit expected observations, following Part 1's precedent for `voiceCaptureProcessor.js` and `voiceRecognitionWorker.ts`.

**3. Type consistency.** `voicePrepareDisplay(progress: VoiceDictationPrepareProgress | null): VoicePrepareDisplay` is spelled identically in Task 2's implementation, Task 2's test and Task 5's component. `VoicePrepareDisplay` is exactly `{ label: string; detail: string; percent: number | null }` in all three. `formatVoicePackageSize(totalBytes: number): string` matches its single call site in Task 7. `voiceComposerMode(phase) → 'compose' | 'preparing' | 'recording'` matches the three-way branch in Task 7. `voiceDownloadDecision({ supported, packageCached, consentRemembered })` has those three property names in Task 4's implementation, Task 4's test and Task 7's `handleVoicePress`. `VoicePreparingBar`'s props (`progress`, `onCancel`, `textClass`, `mutedClass`) and `VoiceDownloadConsent`'s props (`sizeLabel`, `onAccept`, `onCancel`, `borderClass`, `surfaceClass`, `textClass`, `mutedClass`) match their tests and their call sites in Task 7 exactly. `useVoiceDictation`'s three new return fields (`packageCached`, `consentRemembered`, `rememberConsent`) match their three uses in Task 7. `VoiceEngineCredit`'s four fields match Task 8's test and Task 9's `.map`. `VOICE_MODEL_TOTAL_BYTES`, `isVoiceModelCached`, `deleteVoiceModelPackage`, `browserVoiceModelCacheDeps` and `createLocalVoiceDictationAdapter` were all confirmed against the live exports of `voiceModelCache.ts` and `localVoiceDictation.ts`, not against Part 1's plan text.

**4. Review Focus.** Each of the five lines has a test in the task that owns the code, and the two that cross into untestable screen wiring also have a numbered hands-on step: 1 → Task 4's `packageCached: true` and `packageCached: null` cases, plus Task 10 check 2; 2 → Task 4's "a decline leaves no trace" case, plus Task 10 check 3; 3 → Task 3's six `voiceComposerMode` cases and Task 5's indeterminate/determinate cases, plus Task 10 checks 4 and 5; 4 → Task 4's `supported: false` cases, plus Task 10 check 7; 5 → Task 10 check 8, which is a verification rather than a test because the claim being checked ("these two cannot overlap") is about React's unmount behavior, which nothing in this repository can assert.

**Issues found and fixed inline while reviewing.**
(a) The brief stated that `browserVoiceDictation.cases.test.ts` asserts the «Microsoft Edge» copy. It does not — it asserts error codes only and never imports `voiceDictationErrorCopy`; the assertion is in `voiceDictationContract.cases.test.ts:44-47`. This collapsed what looked like a contract-shaped problem (a second parameter, or a separate error code for the local adapter) into a one-assertion flip in one file. The plan says so explicitly so the implementer does not go looking for a problem that is not there.
(b) `VoiceDictationBar` would have rendered «Слушаю…» with a ticking timer throughout an 83 MB download, because `voiceActive` includes `preparing` and the bar's label only special-cases `'starting'`. Fixed by Task 3's third composer mode rather than by editing the bar, which keeps the bar's existing test untouched and keeps `shouldStopVoiceDictation` correct for its other callers.
(c) Keeping the textarea live during `preparing` — the literal reading of «без блокировки остального интерфейса чата» — would have made the Send button reachable mid-download, where `handleSend`'s first line silently cancels the download, and where `useVoiceDictation({ disabled: sending })` would cancel it anyway the moment sending began. Resolved by replacing the composer row during preparing, with the reasoning written into Task 3 so it is not quietly reversed later.
(d) Deleting the package without clearing the consent flag would have made the next microphone press start an 83 MB download with no question — a hidden background download, the exact thing product rule 7 forbids. `forgetVoiceDownloadConsent` was added to Task 4 and called from Task 9.
(e) `.voice-wave-fallback` was the obvious class to reuse for the indeterminate bar, but it animates `scaleY` and is built for the nine-bar waveform. Replaced with `animate-pulse motion-reduce:animate-none`, which keeps the reduced-motion care the existing CSS already takes.
(f) Tasks 7's two files were initially separate tasks. Merged, because the intermediate commit would have had a live on-device adapter with no consent gate.
