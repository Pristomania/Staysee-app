import { useState } from 'react';
import { ChevronDown, MessagesSquare } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

export type ConvOption = { id: string; title: string };

interface ConversationScopePickerProps {
  options: ConvOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  emptyLabel?: string;
  /** Те же классы, что у карточек на экране (Memory и т.д.). */
  cardClass?: string;
}

export function ConversationScopePicker({
  options,
  selectedId,
  onSelect,
  emptyLabel = 'Нет активных бесед',
  cardClass,
}: ConversationScopePickerProps) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);

  const card =
    cardClass ?? `w-full rounded-xl border ${theme.surface} ${theme.border}`;

  const selected = options.find((c) => c.id === selectedId);
  const selectedTitle = selected?.title?.trim() || 'Без названия';

  if (options.length === 0) {
    return (
      <p className={`${theme.textMuted} text-sm font-light`}>{emptyLabel}</p>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${card} flex items-center gap-3 px-4 py-3 text-left ${theme.surfaceHover} transition-colors`}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <MessagesSquare
          className={`w-4 h-4 shrink-0 ${theme.textSecondary} opacity-75`}
          strokeWidth={1.5}
        />
        <div className="flex-1 min-w-0">
          <p className={`${theme.textMuted} text-[11px] font-light tracking-wide opacity-90`}>
            Беседа
          </p>
          <p className={`${theme.textPrimary} text-sm font-light truncate mt-0.5`}>
            {selectedTitle}
          </p>
        </div>
        <ChevronDown
          className={`w-4 h-4 ${theme.textMuted} shrink-0 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
          strokeWidth={1.5}
        />
      </button>

      {open && (
        <ul
          className="mt-1.5 space-y-1 max-h-48 overflow-y-auto scrollbar-hide"
          role="listbox"
        >
          {options.map((c) => {
            const isActive = c.id === selectedId;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    onSelect(c.id);
                    setOpen(false);
                  }}
                  className={`
                    ${card} w-full text-left px-4 py-2.5 text-sm font-light transition-all duration-200
                    ${theme.surfaceHover}
                    ${isActive ? 'ring-1 ring-[#c9a96e]/25 border-[#c9a96e]/20' : ''}
                  `}
                >
                  <span className={isActive ? 'text-[#c9a96e]' : theme.textSecondary}>
                    {c.title?.trim() || 'Без названия'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
