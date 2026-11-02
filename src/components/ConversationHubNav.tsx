import { Lock } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { usePlan } from '../context/PlanContext';
import { useTheme } from '../context/ThemeContext';
import { DYNAMICS_COPY } from '../lib/dynamicsCopy';
import type { PlanFeature } from '../lib/plans';
import type { Screen } from '../types';

export type ConversationHubTab = 'chat' | 'memory' | 'dynamics' | 'notes';

const TAB_CONFIG: { id: ConversationHubTab; label: string; screen: Screen; feature?: PlanFeature }[] = [
  { id: 'chat', label: DYNAMICS_COPY.hubChat, screen: 'chat' },
  { id: 'memory', label: DYNAMICS_COPY.hubMemory, screen: 'memory', feature: 'crossMemory' },
  { id: 'dynamics', label: DYNAMICS_COPY.hubDynamics, screen: 'conversation-dynamics', feature: 'conversationDynamics' },
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
  const { has } = usePlan();

  if (!show || !currentConversation?.id) return null;

  return (
    <nav
      className={`flex gap-1 p-1 rounded-xl border mb-4 ${theme.border} ${theme.surface}`}
      aria-label="Разделы беседы"
    >
      {TAB_CONFIG.map((tab) => {
        const isActive = tab.id === active;
        // A closed section stays in the row, marked, and opens to the "after payment" view.
        const locked = tab.feature ? !has(tab.feature) : false;
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
            <span className="block truncate">
              {tab.label}
              {locked && <Lock className="ml-1 inline h-2.5 w-2.5 text-[#c9a96e]" strokeWidth={2} />}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
