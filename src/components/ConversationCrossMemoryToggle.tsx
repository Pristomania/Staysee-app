import { useEffect, useState } from 'react';
import { Link2 } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { setConversationCrossMemoryEnabled } from '../lib/conversationMemorySettings';

interface ConversationCrossMemoryToggleProps {
  conversationId: string;
  enabled: boolean;
  profileDefaultEnabled: boolean;
  cardClass: string;
  onChanged(enabled: boolean): void;
}

export function ConversationCrossMemoryToggle({
  conversationId,
  enabled,
  profileDefaultEnabled,
  cardClass,
  onChanged,
}: ConversationCrossMemoryToggleProps) {
  const { theme } = useTheme();
  const [confirmedEnabled, setConfirmedEnabled] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setConfirmedEnabled(enabled);
  }, [enabled, conversationId]);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const next = !confirmedEnabled;
    const { ok } = await setConversationCrossMemoryEnabled(conversationId, next);
    if (ok) {
      setConfirmedEnabled(next);
      onChanged(next);
    } else {
      setFailed(true);
    }
    setBusy(false);
  }

  const isException = !profileDefaultEnabled && confirmedEnabled;

  return (
    <div className={`${cardClass} px-4 py-3.5`}>
      <div className="flex items-start justify-between gap-4">
        <Link2
          className={`w-4 h-4 ${theme.textSecondary} shrink-0 mt-0.5 opacity-75`}
          strokeWidth={1.5}
        />
        <div className="min-w-0 flex-1">
          <p className={`${theme.textPrimary} text-sm font-light`}>
            Учитывать сквозную память
          </p>
          <p className={`${theme.textMuted} text-xs font-light mt-1 leading-relaxed opacity-90`}>
            {confirmedEnabled
              ? 'Учитывает общие факты и может сохранять новые.'
              : 'Использует только память этой беседы.'}
          </p>
          {isException && (
            <p className={`${theme.textSecondary} text-xs font-light mt-2 leading-relaxed`}>
              Включена только здесь.
            </p>
          )}
          {failed && (
            <p className="text-red-400/90 text-xs font-light mt-2" role="status">
              Не удалось сохранить. Нажми ещё раз.
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={confirmedEnabled}
          aria-label="Учитывать сквозную память"
          disabled={busy}
          onClick={() => void toggle()}
          className={`
            shrink-0 relative w-11 h-6 rounded-full transition-colors duration-200
            disabled:opacity-50
            ${confirmedEnabled ? 'bg-[#c9a96e]/55' : `${theme.border} border opacity-80`}
          `}
        >
          <span
            className={`
              absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-[#ece9e3] shadow-sm
              transition-transform duration-200
              ${confirmedEnabled ? 'translate-x-5' : 'translate-x-0'}
            `}
          />
        </button>
      </div>
    </div>
  );
}
