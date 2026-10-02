import { Mic, Square } from 'lucide-react';
import {
  formatDictationDuration,
  normalizeVoiceLevel,
  type VoiceDictationPhase,
} from '../../lib/voiceDictationContract';

const BAR_MULTIPLIERS = [0.48, 0.72, 0.9, 0.62, 1, 0.62, 0.9, 0.72, 0.48] as const;

export function VoiceDictationBar(props: {
  elapsedMs: number;
  level: number;
  phase: VoiceDictationPhase;
  onStop(): void;
  textClass: string;
  mutedClass: string;
}) {
  const { elapsedMs, level, phase, onStop, textClass, mutedClass } = props;
  const normalizedLevel = normalizeVoiceLevel(level);
  const fallback = normalizedLevel === 0;

  return (
    <div
      className="flex min-h-11 flex-1 items-center gap-3"
      role="status"
      aria-live="polite"
      aria-label={phase === 'starting' ? 'Голосовой ввод запускается' : 'Идёт голосовой ввод'}
    >
      <Mic className="h-4 w-4 shrink-0 text-[#c9a96e]" strokeWidth={1.6} />
      <span className={`shrink-0 text-sm font-light ${textClass}`}>
        {phase === 'starting' ? 'Подготавливаю…' : 'Слушаю…'}
      </span>
      <div
        className={`flex h-6 min-w-0 flex-1 items-center justify-center gap-1 ${fallback ? 'voice-wave-fallback' : ''}`}
        data-voice-wave={fallback ? 'fallback' : 'live'}
        aria-hidden="true"
      >
        {BAR_MULTIPLIERS.map((multiplier, index) => {
          const scale = fallback ? multiplier * 0.5 : Math.max(0.22, normalizedLevel * multiplier);
          return (
            <span
              key={index}
              data-voice-bar={`bar-${index}`}
              className="h-5 w-0.5 rounded-full bg-[#c9a96e]/70 transition-transform duration-100"
              style={{ transform: `scaleY(${scale})` }}
            />
          );
        })}
      </div>
      <span className={`w-9 shrink-0 text-right text-xs tabular-nums ${mutedClass}`}>
        {formatDictationDuration(elapsedMs)}
      </span>
      <button
        type="button"
        onClick={onStop}
        aria-label="Остановить голосовой ввод"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[#c9a96e]/25 bg-[#c9a96e]/8 transition-colors hover:bg-[#c9a96e]/14"
      >
        <Square
          className="h-3.5 w-3.5 text-[#c9a96e]/90"
          strokeWidth={1.5}
          fill="currentColor"
        />
      </button>
    </div>
  );
}
