import { useEffect, useRef } from 'react';
import { Image as ImageIcon } from 'lucide-react';

/**
 * The consent to the processing of pictures, asked once, before the person's first picture (the server takes
 * pictures only after it is recorded). Shaped after VoiceDownloadConsent: a bordered row with an icon, the text
 * and its actions, `role="group"` rather than a dialog (no focus trap, the chat behind stays readable).
 */
export function ImagesConsentCard(props: {
  /** The notice text; its hash is what the consent log stores (src/lib/imagesConsent.ts). */
  text: string;
  onAccept(): void;
  onCancel(): void;
  borderClass: string;
  surfaceClass: string;
  textClass: string;
  mutedClass: string;
}) {
  const { text, onAccept, onCancel, borderClass, surfaceClass, textClass, mutedClass } = props;

  const acceptRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    acceptRef.current?.focus();
  }, []);

  return (
    <div
      className={`mb-3 rounded-xl border ${borderClass} ${surfaceClass} px-4 py-3 flex items-start gap-3`}
      role="group"
      aria-live="polite"
      aria-label="Согласие на обработку картинок"
    >
      <ImageIcon className="w-4 h-4 mt-0.5 shrink-0 text-[#c9a96e]" strokeWidth={1.5} />
      <div className="flex-1 min-w-0">
        <p className={`${textClass} text-xs font-light leading-relaxed`}>{text}</p>
        <p className={`${mutedClass} text-xs font-light leading-relaxed mt-1.5`}>
          Нажимая «Даю согласие», вы соглашаетесь на обработку картинок на этих условиях. Согласие запоминается, больше мы не спросим.
        </p>
        <div className="flex gap-2 mt-2.5">
          <button
            ref={acceptRef}
            type="button"
            onClick={onAccept}
            aria-label="Дать согласие на обработку картинок"
            className="px-3 py-1.5 rounded-lg border border-[#c9a96e]/30 bg-[#c9a96e]/8 text-[#c9a96e]/90 text-xs font-light transition-colors duration-200 hover:bg-[#c9a96e]/14"
          >
            Даю согласие
          </button>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Не прикреплять картинку"
            className={`px-3 py-1.5 rounded-lg border text-xs font-light transition-colors duration-200 ${borderClass} ${mutedClass}`}
          >
            Не сейчас
          </button>
        </div>
      </div>
    </div>
  );
}
