import { useEffect, useRef } from 'react';
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

  const downloadButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    downloadButtonRef.current?.focus();
  }, []);

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
            ref={downloadButtonRef}
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
