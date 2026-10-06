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
