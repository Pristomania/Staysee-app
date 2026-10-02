export interface DeferredVoiceDisposer {
  mount(): void;
  unmount(): void;
}

export function createDeferredVoiceDisposer(options: {
  dispose(): void;
  schedule(callback: () => void): number;
  cancel(id: number): void;
}): DeferredVoiceDisposer {
  let pendingId: number | null = null;
  let disposed = false;

  return {
    mount() {
      if (pendingId === null) return;
      options.cancel(pendingId);
      pendingId = null;
    },
    unmount() {
      if (disposed || pendingId !== null) return;
      pendingId = options.schedule(() => {
        pendingId = null;
        if (disposed) return;
        disposed = true;
        options.dispose();
      });
    },
  };
}
