import { Gauge } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTheme } from '../context/ThemeContext';
import { lowMessagesLine, type MessageCounter } from '../lib/messageCounter';

/** The warning above the composer: from ten messages left until the end. */
export function LowMessagesNotice({ counter }: { counter: MessageCounter }) {
  const { theme } = useTheme();
  const { navigateTo } = useApp();
  return (
    <div role="status" className={`mb-2 flex items-center gap-3 rounded-xl border px-4 py-2.5 ${theme.surface} ${theme.border}`}>
      <Gauge className={`h-4 w-4 shrink-0 ${theme.textSecondary} opacity-75`} strokeWidth={1.5} />
      <p className={`flex-1 text-sm font-light ${theme.textSecondary}`}>{lowMessagesLine(counter)}</p>
      <button
        type="button"
        onClick={() => navigateTo('tariffs')}
        className={`shrink-0 text-xs font-light underline decoration-dotted underline-offset-4 ${theme.btnText}`}
      >
        Тарифы
      </button>
    </div>
  );
}
