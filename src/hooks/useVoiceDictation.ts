import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { createBrowserVoiceDictationAdapter } from '../lib/browserVoiceDictation';
import {
  createVoiceDictationController,
  type VoiceDictationController,
} from '../lib/voiceDictationController';
import { shouldApplyVoicePreview } from '../lib/chatVoiceIntegration';

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
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    if (disabled) controller.stop();
  }, [controller, disabled]);

  useEffect(() => () => controller.stop(), [controller, conversationId]);
  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (shouldApplyVoicePreview(snapshot) && snapshot.previewDraft !== draft) {
      onDraftChange(snapshot.previewDraft);
    }
  }, [draft, onDraftChange, snapshot]);

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
