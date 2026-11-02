import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import type { Theme } from '../../context/ThemeContext';
import {
  Activity,
  Brain,
  ChevronDown,
  Feather,
  FileText,
  Gauge,
  LogOut,
  MessageCircle,
  ScrollText,
  Shield,
  type LucideIcon,
} from 'lucide-react';
import { ThemePicker } from '../ThemePicker';
import { usePlan } from '../../context/PlanContext';
import { counterLine, renewalLine } from '../../lib/messageCounter';
import { ROOM_COPY } from '../../lib/roomCopy';
import { DeleteAccountDataSection } from '../DeleteAccountDataSection';
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
  icon: LucideIcon;
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
  const { signOut } = useAuth();
  const {
    navigateTo,
    navigateBack,
    replaceNavigation,
    setConversations,
    setMessages,
    setCurrentConversation,
  } = useApp();
  const { theme } = useTheme();
  const { tier, plan: currentPlan, counter, loaded: planLoaded } = usePlan();
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [legalOpen, setLegalOpen] = useState(false);
  const sectionLabel = useSectionLabelClass();

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
      {counter && (
        <div className={`${card} px-4 py-3 mb-6`}>
          <div className="flex items-center gap-3">
            <Gauge className={`w-4 h-4 shrink-0 ${theme.textSecondary} opacity-75`} strokeWidth={1.5} />
            <p className={`flex-1 ${theme.textSecondary} text-sm font-light`}>
              {currentPlan.label} · {counterLine(counter)}
            </p>
            <button
              type="button"
              onClick={() => navigateTo('tariffs')}
              className={`shrink-0 text-xs font-light underline decoration-dotted underline-offset-4 ${theme.btnText}`}
            >
              Тарифы
            </button>
          </div>
          {renewalLine(counter, tier) && (
            <p className={`${theme.textMuted} mt-1.5 pl-7 text-xs font-light opacity-85`}>{renewalLine(counter, tier)}</p>
          )}
        </div>
      )}

      <section className="mb-6">
        <ThemePicker />
      </section>

      <section className="mb-6">
        <p className={sectionLabel}>Беседы</p>
        <div className="space-y-1.5">
          <CabinetRow
            icon={Activity}
            title="Динамика бесед"
            theme={theme}
            cardClass={card}
            onClick={() => {
              navigateTo('conversation-dynamics', { dynamicsReturnScreen: 'profile' });
            }}
          />
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
              { title: 'Политика обработки данных', screen: 'policy' as const, icon: FileText },
              { title: 'Согласие на обработку данных', screen: 'consent' as const, icon: FileText },
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

      {/* Two different things: the data of the account (free plan only, the account stays) and the room itself. */}
      {planLoaded && tier === 'free' && (
        <div className="mb-3">
          <DeleteAccountDataSection />
        </div>
      )}
      <DeleteRoomSection cardClass={card} onDeleted={handleRoomDeleted} />

      <p className={`mt-6 ${theme.textMuted} text-[11px] font-light leading-relaxed opacity-50 text-center`}>
        Беседы принадлежат вам. Мы не читаем их в штатном режиме.
      </p>
    </StickyScreenLayout>
  );
}
