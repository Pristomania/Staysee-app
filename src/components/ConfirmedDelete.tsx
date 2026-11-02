import { useState } from 'react';
import { useTheme } from '../context/ThemeContext';

type State = 'idle' | 'confirming' | 'loading' | 'done' | 'error';

/**
 * A deletion the person has to confirm once: a card with what it does, the button, and then "Да, удалить" or "Отмена".
 * `onRun` does the deleting and says whether it all went through.
 */
export function ConfirmedDelete({
  title,
  hint,
  buttonLabel,
  doneText,
  onRun,
}: {
  title?: string;
  hint: string;
  buttonLabel: string;
  doneText: string;
  onRun: () => Promise<boolean>;
}) {
  const { theme } = useTheme();
  const [state, setState] = useState<State>('idle');

  async function confirm() {
    setState('loading');
    try {
      setState((await onRun()) ? 'done' : 'error');
    } catch {
      setState('error');
    }
  }

  return (
    <div className={`rounded-xl border border-red-400/20 ${theme.surface} px-4 py-4`}>
      {title && <p className={`${theme.textPrimary} mb-1 text-sm font-light`}>{title}</p>}
      <p className={`${theme.textSecondary} mb-3 text-xs font-light leading-relaxed`}>{hint}</p>
      {state === 'done' ? (
        <p className={`${theme.textSecondary} text-xs font-light`}>{doneText}</p>
      ) : state === 'error' ? (
        <div className="space-y-2">
          <p className="text-xs font-light text-red-400/80">Не всё получилось удалить. Попробуйте ещё раз.</p>
          <button
            type="button"
            onClick={() => setState('confirming')}
            className="rounded-lg border border-red-400/20 bg-red-400/5 px-4 py-2 text-xs font-light text-red-400/80"
          >
            Ещё раз
          </button>
        </div>
      ) : state === 'confirming' ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setState('idle')}
            className={`flex-1 rounded-lg border py-2 text-xs font-light ${theme.btnBg} ${theme.btnBorder} ${theme.textSecondary}`}
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            className="flex-1 rounded-lg border border-red-400/25 bg-red-400/5 py-2 text-xs font-light text-red-400/85 hover:bg-red-400/10"
          >
            Да, удалить
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setState('confirming')}
          disabled={state === 'loading'}
          className="rounded-lg border border-red-400/25 bg-red-400/5 px-4 py-2 text-xs font-light text-red-400/85 hover:bg-red-400/10 disabled:opacity-40"
        >
          {state === 'loading' ? 'Удаляю…' : buttonLabel}
        </button>
      )}
    </div>
  );
}
