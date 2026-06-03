import { useState, type ReactNode } from 'react';
import { Trash2, X } from 'lucide-react';
import type { Theme } from '../context/ThemeContext';
import { REFLECTION_COPY } from '../lib/reflectionCopy';

export interface ConfirmDeleteButtonProps {
  onConfirm: () => void;
  theme: Theme;
  /** Shown in two-step confirm (default «Удалить?»). */
  confirmPrompt?: string;
  yesLabel?: string;
  /** Text/icon trigger; default — icon trash only. */
  label?: ReactNode;
  className?: string;
  disabled?: boolean;
}

/**
 * Two-step delete: trash → «Удалить?» · Да · ✕
 */
export function ConfirmDeleteButton({
  onConfirm,
  theme,
  confirmPrompt = REFLECTION_COPY.deleteConfirm,
  yesLabel = REFLECTION_COPY.deleteYes,
  label,
  className = '',
  disabled = false,
}: ConfirmDeleteButtonProps) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className={`flex items-center gap-1.5 shrink-0 ${className}`}>
        <span className={`${theme.textMuted} text-[11px] font-light whitespace-nowrap`}>
          {confirmPrompt}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            onConfirm();
            setConfirming(false);
          }}
          className={`px-2 py-1 rounded-lg text-[11px] font-light ${theme.surfaceHover} ${theme.textSecondary} disabled:opacity-40`}
        >
          {yesLabel}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className={`p-1 rounded-lg ${theme.surfaceHover}`}
          aria-label={REFLECTION_COPY.deleteCancel}
        >
          <X className={`w-3.5 h-3.5 ${theme.textMuted}`} strokeWidth={1.5} />
        </button>
      </div>
    );
  }

  if (label) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setConfirming(true)}
        className={`inline-flex items-center gap-1.5 font-light opacity-80 hover:opacity-100 disabled:opacity-40 ${className}`}
      >
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setConfirming(true)}
      className={`shrink-0 p-1.5 rounded-lg opacity-60 hover:opacity-100 ${theme.surfaceHover} disabled:opacity-40 ${className}`}
      aria-label={REFLECTION_COPY.deleteAria}
    >
      <Trash2 className={`w-3.5 h-3.5 ${theme.textMuted}`} strokeWidth={1.5} />
    </button>
  );
}
