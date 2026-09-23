import { useState } from 'react';
import type { Theme } from '../context/ThemeContext';
import { ConfirmDeleteButton } from './ConfirmDeleteButton';
import type { MemoryV3ViewerItem } from '../lib/memoryV3Viewer';

const KIND_ORDER = ['event', 'recurrence'] as const;
const KIND_LABELS: Record<(typeof KIND_ORDER)[number], string> = {
  event: 'События',
  recurrence: 'Повторяющееся',
};
const VISIBLE_PER_GROUP = 5;

/** Список подтверждённых записей "умной" памяти, сгруппированный по типу
 * (события / повторяющееся) — посмотреть и удалить. Каждая группа
 * показывает только самые свежие записи (сервер уже отдаёт их в этом
 * порядке), остальное — за кнопкой "Показать ещё". Чувствительные записи
 * по умолчанию свёрнуты. */
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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  if (items.length === 0) {
    return (
      <div className={`${cardBase} px-4 py-3.5`}>
        <p className={`${theme.textMuted} text-sm font-light leading-relaxed`}>{emptyMessage}</p>
      </div>
    );
  }

  const groups = KIND_ORDER
    .map((kind) => ({ kind, groupItems: items.filter((item) => item.kind === kind) }))
    .filter((group) => group.groupItems.length > 0);

  return (
    <div className="space-y-3">
      {groups.map(({ kind, groupItems }) => {
        const isExpanded = expandedGroups.has(kind);
        const visibleItems = isExpanded ? groupItems : groupItems.slice(0, VISIBLE_PER_GROUP);
        const hiddenCount = groupItems.length - visibleItems.length;
        return (
          <div key={kind} className="space-y-1.5">
            <p className={`${theme.textMuted} text-[11px] font-light px-1 opacity-80`}>
              {KIND_LABELS[kind]}
            </p>
            <ul className="space-y-1.5">
              {visibleItems.map((item) => {
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
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setExpandedGroups((prev) => new Set(prev).add(kind))}
                className={`${theme.textMuted} text-xs font-light px-1`}
              >
                Показать ещё {hiddenCount}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
