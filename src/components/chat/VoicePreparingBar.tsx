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
      className="flex min-h-11 min-w-0 flex-1 items-center gap-3"
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
