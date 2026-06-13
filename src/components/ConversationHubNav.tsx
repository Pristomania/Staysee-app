import { useApp } from '../context/AppContext';
import { useTheme } from '../context/ThemeContext';
import { DYNAMICS_COPY } from '../lib/dynamicsCopy';
import type { Screen } from '../types';

export type ConversationHubTab = 'chat' | 'memory' | 'dynamics' | 'notes';

const TAB_CONFIG: { id: ConversationHubTab; label: string; screen: Screen }[] = [
  { id: 'chat', label: DYNAMICS_COPY.hubChat, screen: 'chat' },
  { id: 'memory', label: DYNAMICS_COPY.hubMemory, screen: 'memory' },
  { id: 'dynamics', label: DYNAMICS_COPY.hubDynamics, screen: 'conversation-dynamics' },
  { id: 'notes', label: DYNAMICS_COPY.hubNotes, screen: 'conversation-notes' },
];

export function ConversationHubNav({
  active,
  show,
}: {
  active: ConversationHubTab;
  show: boolean;
}) {
  const { theme } = useTheme();
  const { navigateTo, currentConversation } = useApp();

  if (!show || !currentConversation?.id) return null;

  return (
    <nav
      className={`flex gap-1 p-1 rounded-xl border mb-4 ${theme.border} ${theme.surface}`}
      aria-label="Разделы беседы"
    >
      {TAB_CONFIG.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            disabled={isActive}
            onClick={() => {
              if (isActive) return;
              navigateTo(tab.screen, {
                conversation: currentConversation,
                memoryReturnScreen: 'chat',
                notesReturnScreen: 'chat',
                dynamicsReturnScreen: 'chat',
              });
            }}
            className={`
              flex-1 min-w-0 py-2 px-1 rounded-lg text-[11px] sm:text-xs font-light transition-all
              ${isActive
                ? `${theme.btnBg} ${theme.textPrimary} opacity-100`
                : `${theme.textMuted} hover:opacity-100 opacity-75`}
            `}
          >
            <span className="block truncate">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
