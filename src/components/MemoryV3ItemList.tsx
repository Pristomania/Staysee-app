import { useState } from 'react';
import type { Theme } from '../context/ThemeContext';
import { ConfirmDeleteButton } from './ConfirmDeleteButton';
import type { MemoryV3ViewerItem } from '../lib/memoryV3Viewer';

const VISIBLE_PER_GROUP = 5;
const UNCATEGORIZED_GROUP_KEY = '__uncategorized__';
const UNCATEGORIZED_LABEL = 'Разное';

/** Список подтверждённых записей "умной" памяти, сгруппированный по теме
 * (переданной вызывающим экраном через topicLabels, свой набор для памяти
 * беседы и для сквозной памяти) — посмотреть и удалить. Записи без темы
 * (ещё не разобраны разовым проходом нейросети) попадают в отдельную
 * группу "Разное" в конце. Каждая группа показывает только 5 самых свежих
 * записей (сервер уже отдаёт их в этом порядке), остальное — за кнопкой
 * "Показать ещё". Чувствительные записи по умолчанию свёрнуты. */
export function MemoryV3ItemList({
  items,
  theme,
  cardBase,
  onDelete,
  emptyMessage,
  topicLabels,
}: {
  items: MemoryV3ViewerItem[];
  theme: Theme;
  cardBase: string;
  onDelete: (item: MemoryV3ViewerItem) => void;
  emptyMessage: string;
  topicLabels: Record<string, string>;
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

  const groups = [
    ...Object.keys(topicLabels).map((topic) => ({
      key: topic,
      label: topicLabels[topic],
      groupItems: items.filter((item) => item.topic === topic),
    })),
    {
      key: UNCATEGORIZED_GROUP_KEY,
      label: UNCATEGORIZED_LABEL,
      groupItems: items.filter(
        (item) => item.topic === null || !Object.prototype.hasOwnProperty.call(topicLabels, item.topic),
      ),
    },
  ].filter((group) => group.groupItems.length > 0);

  return (
    <div className="space-y-3">
      {groups.map(({ key, label, groupItems }) => {
        const isExpanded = expandedGroups.has(key);
        const visibleItems = isExpanded ? groupItems : groupItems.slice(0, VISIBLE_PER_GROUP);
        const hiddenCount = groupItems.length - visibleItems.length;
        return (
          <div key={key} className="space-y-1.5">
            <p className={`${theme.textMuted} text-[11px] font-light px-1 opacity-80`}>
              {label}
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
                onClick={() => setExpandedGroups((prev) => new Set(prev).add(key))}
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
