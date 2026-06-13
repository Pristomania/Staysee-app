import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { isCrossMemoryEnabled, setCrossMemoryEnabled } from '../lib/profileSettings';

const COPY = {
  title: 'Сквозная память',
  on: 'Включена — StaySee может опираться на фразы из разных бесед.',
  off: 'Выключена — в чат подставляется только память этой беседы.',
  aria: 'Сквозная память между беседами',
} as const;

export function CrossMemoryToggle({
  cardClass,
  embedded = false,
}: {
  cardClass: string;
  /** Inline row without card chrome — for Memory screen header area */
  embedded?: boolean;
}) {
  const { user, profile, refreshProfile } = useAuth();
  const { theme } = useTheme();
  const [busy, setBusy] = useState(false);

  const enabled = isCrossMemoryEnabled(profile);

  async function toggle() {
    if (!user || busy) return;
    setBusy(true);
    const next = !enabled;
    const { ok } = await setCrossMemoryEnabled(user.id, next);
    if (ok) await refreshProfile();
    setBusy(false);
  }

  const statusShort = enabled ? 'включена' : 'отключена';

  const toggleButton = (
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={COPY.aria}
          disabled={busy}
          onClick={() => void toggle()}
          className={`
            shrink-0 relative w-11 h-6 rounded-full transition-colors duration-200
            disabled:opacity-50
            ${enabled ? 'bg-[#c9a96e]/55' : `${theme.border} border opacity-80`}
          `}
        >
          <span
            className={`
              absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-[#ece9e3] shadow-sm
              transition-transform duration-200
              ${enabled ? 'translate-x-5' : 'translate-x-0'}
            `}
          />
        </button>
  );

  if (embedded) {
    return (
      <div className="flex items-center justify-between gap-3 py-1">
        <p className={`${theme.textMuted} text-xs font-light`}>
          Статус: <span className={theme.textSecondary}>{statusShort}</span>
        </p>
        {toggleButton}
      </div>
    );
  }

  return (
    <div className={`${cardClass} px-4 py-3.5`}>
      <div className="flex items-start justify-between gap-4">
        <Link2
          className={`w-4 h-4 ${theme.textSecondary} shrink-0 mt-0.5 opacity-75`}
          strokeWidth={1.5}
        />
        <div className="min-w-0 flex-1">
          <p className={`${theme.textPrimary} text-sm font-light`}>{COPY.title}</p>
          <p className={`${theme.textMuted} text-xs font-light mt-1 leading-relaxed opacity-90`}>
            {enabled ? COPY.on : COPY.off}
          </p>
        </div>
        {toggleButton}
      </div>
    </div>
  );
}
