import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { createBrowserVoiceDictationAdapter } from '../lib/browserVoiceDictation';
import {
  createVoiceDictationController,
  type VoiceDictationController,
} from '../lib/voiceDictationController';
import { shouldApplyVoiceSnapshot } from '../lib/chatVoiceIntegration';
import { createDeferredVoiceDisposer } from '../lib/voiceDictationLifecycle';

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
      adapter: createBrowserVoiceDictationAdapter(),
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

  return {
    snapshot,
    start,
    stop: controller.stop,
    clearError: controller.clearError,
  };
}
