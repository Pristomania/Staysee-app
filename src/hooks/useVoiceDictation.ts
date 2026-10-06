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
