import { useEffect, useState, type ComponentType } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import type { Theme } from '../../context/ThemeContext';
import {
  Brain,
  ChevronDown,
  Feather,
  FileText,
  Gauge,
  LogOut,
  MessageCircle,
  ScrollText,
  Shield,
} from 'lucide-react';
import { ThemePicker } from '../ThemePicker';
import { fetchUsageTier, tierLabel } from '../../lib/usageTier';
import { ROOM_COPY } from '../../lib/roomCopy';
import { CrossMemoryToggle } from '../CrossMemoryToggle';
import { DeleteRoomSection } from '../DeleteRoomSection';
import { ScreenBackHeader, StickyScreenLayout, useSectionLabelClass } from '../layout';

const GUIDANCE_BLOCKS = [
  {
    title: 'Если сложно начать',
    prompts: [
      'Я не понимаю, что со мной происходит.',
      'Мне нужно просто выговориться.',
    ],
  },
  {
    title: 'Если хочется разобраться',
    prompts: [
      'Что в этой ситуации повторяется?',
      'Где я снова иду против себя?',
    ],
  },
  {
    title: 'Если нужен шаг',
    prompts: [
      'Помоги мне разложить это по полкам.',
      'Какой маленький шаг я могу сделать сейчас?',
    ],
  },
];

function CabinetRow({
  icon: Icon,
  title,
  theme,
  cardClass,
  onClick,
  expanded,
  trailing = 'navigate',
}: {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  theme: Theme;
  cardClass: string;
  onClick?: () => void;
  expanded?: boolean;
  trailing?: 'expand' | 'navigate';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${cardClass} w-full flex items-center gap-3 px-4 py-3 text-left ${theme.surfaceHover} transition-colors`}
    >
      <Icon className={`w-4 h-4 ${theme.textSecondary} shrink-0 opacity-75`} strokeWidth={1.5} />
      <span className={`${theme.textPrimary} text-sm font-light flex-1`}>{title}</span>
      {trailing === 'expand' ? (
        <ChevronDown
          className={`w-4 h-4 ${theme.textMuted} shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          strokeWidth={1.5}
        />
      ) : (
        <span className={`${theme.textMuted} text-xs opacity-50`}>›</span>
      )}
    </button>
  );
}

export function ProfileScreen() {
  const { signOut, user } = useAuth();
  const {
    navigateTo,
    navigateBack,
    replaceNavigation,
    setConversations,
    setMessages,
    setCurrentConversation,
  } = useApp();
  const { theme } = useTheme();
  const [usageText, setUsageText] = useState<string | null>(null);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [legalOpen, setLegalOpen] = useState(false);
  const sectionLabel = useSectionLabelClass();

  useEffect(() => {
    if (!user) return;
    void fetchUsageTier(user.id).then(({ row, remaining, limit }) => {
      const tier = row ? tierLabel(row.tier) : 'Free';
      setUsageText(`${tier} · сегодня ${remaining} из ${limit}`);
    });
  }, [user]);

  const card = `rounded-xl border ${theme.surface} ${theme.border}`;

  async function handleRoomDeleted() {
    setConversations([]);
    setMessages([]);
    setCurrentConversation(null);
    await signOut();
    replaceNavigation('welcome');
  }

  return (
    <StickyScreenLayout
      header={(
        <ScreenBackHeader
          pinned
          onBack={() => navigateBack()}
          title={ROOM_COPY.contextTitle}
          subtitle={ROOM_COPY.contextSubtitle}
          backLabel="К беседам"
        />
      )}
    >
      {usageText && (
        <div className={`${card} flex items-center gap-3 px-4 py-3 mb-6`}>
          <Gauge className={`w-4 h-4 ${theme.textSecondary} opacity-75`} strokeWidth={1.5} />
          <p className={`${theme.textSecondary} text-sm font-light`}>{usageText}</p>
        </div>
      )}

      <section className="mb-6">
        <ThemePicker />
      </section>

      <section className="mb-6">
        <p className={sectionLabel}>Беседы</p>
        <div className="space-y-1.5">
          <CabinetRow
            icon={Feather}
            title="Записки бесед"
            theme={theme}
            cardClass={card}
            onClick={() => {
              navigateTo('conversation-notes', { notesReturnScreen: 'profile' });
            }}
          />
          <CabinetRow
            icon={Brain}
            title="Память бесед"
            theme={theme}
            cardClass={card}
            onClick={() => {
              navigateTo('memory', { memoryReturnScreen: 'profile' });
            }}
          />
          <CrossMemoryToggle cardClass={card} />
        </div>
      </section>

      <section className="mb-6">
        <CabinetRow
          icon={MessageCircle}
          title="Как начать беседу"
          theme={theme}
          cardClass={card}
          trailing="expand"
          onClick={() => setGuidanceOpen((v) => !v)}
          expanded={guidanceOpen}
        />
        {guidanceOpen && (
          <div className={`mt-1.5 ${card} px-4 py-3 space-y-3`}>
            {GUIDANCE_BLOCKS.map((block) => (
              <div key={block.title}>
                <p className={`${theme.textSecondary} text-xs font-light mb-1.5`}>{block.title}</p>
                {block.prompts.map((p) => (
                  <p
                    key={p}
                    className={`${theme.textMuted} text-xs font-light leading-relaxed pl-3 border-l ${theme.border} mb-1`}
                  >
                    {p}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-6">
        <CabinetRow
          icon={ScrollText}
          title="Документы"
          theme={theme}
          cardClass={card}
          trailing="expand"
          onClick={() => setLegalOpen((v) => !v)}
          expanded={legalOpen}
        />
        {legalOpen && (
          <div className="mt-1.5 space-y-1">
            {[
              { title: 'Публичная оферта', screen: 'terms' as const, icon: FileText },
              { title: 'Конфиденциальность', screen: 'privacy' as const, icon: Shield },
              { title: 'Дисклеймер', screen: 'disclaimer' as const, icon: FileText },
            ].map(({ title, screen, icon }) => (
              <CabinetRow
                key={title}
                icon={icon}
                title={title}
                theme={theme}
                cardClass={card}
                onClick={() => {
                  navigateTo(screen, { legalReturnScreen: 'profile' });
                }}
              />
            ))}
          </div>
        )}
      </section>

      <button
        type="button"
        onClick={() => void signOut()}
        className={`${card} w-full flex items-center gap-3 px-4 py-3.5 mb-8 ${theme.surfaceHover}`}
      >
        <LogOut className={`w-4 h-4 ${theme.textSecondary} opacity-75`} strokeWidth={1.5} />
        <span className={`${theme.textSecondary} text-sm font-light`}>{ROOM_COPY.leaveRoom}</span>
      </button>

      <DeleteRoomSection cardClass={card} onDeleted={handleRoomDeleted} />

      <p className={`mt-6 ${theme.textMuted} text-[11px] font-light leading-relaxed opacity-50 text-center`}>
        Беседы принадлежат вам. Мы не читаем их в штатном режиме.
      </p>
    </StickyScreenLayout>
  );
}
