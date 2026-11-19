import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { EMERGENCY_HELP_COPY } from '../lib/emergencyHelp';

/**
 * The exclamation mark at the end of the top row of the chat. A press opens the approved emergency contacts.
 * Fixed text: nothing here is decided by a model or by words.
 */
export function EmergencyHelpButton() {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`shrink-0 p-2 rounded-lg transition-opacity duration-300 opacity-70 hover:opacity-100 ${theme.surfaceHover}`}
        aria-label={EMERGENCY_HELP_COPY.button}
        title={EMERGENCY_HELP_COPY.button}
        aria-haspopup="dialog"
      >
        <AlertCircle className={`w-4 h-4 ${theme.textSecondary}`} strokeWidth={1.5} />
      </button>
      {/* Drawn at the root of the page: the top row has a blurred background, and inside such a block "fixed" is measured from the block,
          not from the screen (the window slipped out of the top of the screen). */}
      {open && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center px-5 py-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="emergency-help-title"
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/55"
            aria-label={EMERGENCY_HELP_COPY.close}
            tabIndex={-1}
            onClick={() => setOpen(false)}
          />
          <div className={`relative w-full max-w-sm max-h-full overflow-y-auto rounded-2xl border px-5 py-5 ${theme.bg} ${theme.border}`}>
            <h2 id="emergency-help-title" className={`${theme.textPrimary} text-base font-light tracking-wide mb-4`}>
              {EMERGENCY_HELP_COPY.title}
            </h2>
            <div className={`space-y-3 ${theme.textSecondary} text-sm font-light leading-relaxed`}>
              {EMERGENCY_HELP_COPY.rows.map((row, rowIndex) => (
                <p key={rowIndex}>
                  {row.map((part, partIndex) =>
                    typeof part === 'string' ? (
                      <span key={partIndex}>{part}</span>
                    ) : (
                      <a
                        key={partIndex}
                        href={part.href}
                        className={`${theme.textPrimary} underline underline-offset-4 whitespace-nowrap`}
                        {...(part.href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                      >
                        {part.label}
                      </a>
                    ),
                  )}
                </p>
              ))}
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              className={`mt-5 w-full py-3 rounded-xl border transition-all duration-300 ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover}`}
            >
              <span className={`${theme.btnText} font-light text-sm tracking-widest`}>{EMERGENCY_HELP_COPY.close}</span>
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
