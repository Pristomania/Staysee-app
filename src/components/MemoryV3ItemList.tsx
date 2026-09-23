import { useState } from 'react';
import type { Theme } from '../context/ThemeContext';
import { ConfirmDeleteButton } from './ConfirmDeleteButton';
import type { MemoryV3ViewerItem } from '../lib/memoryV3Viewer';

/** Простой список подтверждённых записей "умной" памяти — посмотреть и
 * удалить. Чувствительные записи по умолчанию свёрнуты. */
export function MemoryV3ItemList({
  items,
  theme,
  cardBase,
  onDelete,
  emptyMessage,
}: {
  items: MemoryV3ViewerItem[];
  theme: Theme;
  cardBase: string;
  onDelete: (item: MemoryV3ViewerItem) => void;
  emptyMessage: string;
}) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  if (items.length === 0) {
    return (
      <div className={`${cardBase} px-4 py-3.5`}>
        <p className={`${theme.textMuted} text-sm font-light leading-relaxed`}>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {items.map((item) => {
        const isSensitive = item.sensitivity === 'sensitive';
        const isRevealed = revealed.has(item.memoryKey);
        return (
          <li key={item.memoryKey} className={`${cardBase} px-4 py-3 flex items-center justify-between gap-2`}>
            {isSensitive && !isRevealed ? (
              <button
                type="button"
                onClick={() => setRevealed((prev) => new Set(prev).add(item.memoryKey))}
                className={`${theme.textMuted} text-sm font-light text-left flex-1`}
              >
                Чувствительная запись — показать
              </button>
            ) : (
              <p className={`${theme.textPrimary} text-sm font-light flex-1`}>{item.claim}</p>
            )}
            <ConfirmDeleteButton theme={theme} onConfirm={() => onDelete(item)} />
          </li>
        );
      })}
    </ul>
  );
}
