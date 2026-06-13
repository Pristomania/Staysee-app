import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Pencil, X } from 'lucide-react';
import { ConfirmDeleteButton } from '../ConfirmDeleteButton';
import { ConversationHubNav } from '../ConversationHubNav';
import { ConversationScopePicker } from '../ConversationScopePicker';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import {
  buildAliveView,
  buildChangingView,
  buildRepeatingView,
  fetchConversationMemory,
  fetchCrossMemoryForUser,
  fetchMessageActivityForConversation,
  fetchTensionsForConversation,
  type ConversationDynamicsData,
} from '../../lib/conversationDynamicsView';
import { DYNAMICS_COPY, DYNAMICS_WEEKLY_TREND_MIN_WEEKLIES } from '../../lib/dynamicsCopy';
import { formatWeeklyPeriod } from '../../lib/dynamicsDates';
import { REFLECTION_COPY } from '../../lib/reflectionCopy';
import {
  deleteProgressEntry,
  fetchWeeklyDynamics,
  getWeeklyCooldownStatus,
  saveWeeklyDynamics,
  updateProgressEntry,
  type ProgressEntry,
  type WeeklyCooldownStatus,
} from '../../lib/progressDiary';
import { emptyMemory } from '../../lib/memoryUi';
import { ScreenBackHeader, StickyScreenLayout, useSectionLabelClass } from '../layout';
import type { Conversation } from '../../types';

type ConvOption = Pick<Conversation, 'id' | 'title'>;

function formatDateLong(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatNextAvailable(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function CollapsibleBlock({
  title,
  meta,
  count,
  open,
  onToggle,
  cardClass,
  theme,
  children,
  intro,
}: {
  title: string;
  meta?: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  cardClass: string;
  theme: ReturnType<typeof useTheme>['theme'];
  children: React.ReactNode;
  intro?: string;
}) {
  return (
    <div className="space-y-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`${cardClass} w-full px-4 py-3 flex items-center justify-between gap-3 text-left`}
      >
        <span className={`min-w-0 flex-1 ${theme.textPrimary}`}>
          <span className="block text-sm font-light truncate">{title}</span>
          {meta ? (
            <span className={`block text-[11px] font-light mt-0.5 ${theme.textMuted} opacity-85 truncate`}>
              {meta}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {count != null && count > 0 && !meta ? (
            <span className={`${theme.textMuted} text-xs font-light opacity-80`}>{count}</span>
          ) : null}
          <ChevronDown
            className={`w-4 h-4 ${theme.textMuted} transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            strokeWidth={1.5}
          />
        </span>
      </button>
      {open && (
        <div className={`${cardClass} border-t-0 rounded-t-none px-4 pb-4 pt-2 -mt-px space-y-2`}>
          {intro ? (
            <p className={`${theme.textMuted} text-[11px] font-light opacity-80`}>{intro}</p>
          ) : null}
          {children}
        </div>
      )}
    </div>
  );
}

function TrendGroup({
  direction,
  label,
  items,
  theme,
}: {
  direction: 'up' | 'down' | 'repeat';
  label: string;
  items: string[];
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  if (!items.length) return null;
  const symbol = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '↻';
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${theme.border} bg-black/[0.04]`}>
      <p className={`${theme.textMuted} text-[11px] font-light mb-2 opacity-90`}>
        {symbol} {label}
      </p>
      <ul className="space-y-1.5">
        {items.map((text) => (
          <li
            key={text}
            className={`${theme.textSecondary} text-[13px] font-light leading-[1.6] pl-0 flex gap-2`}
          >
            <span className={`${theme.textMuted} opacity-60 shrink-0`}>•</span>
            <span className="min-w-0 break-words">{text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RepeatingThemesList({
  items,
  theme,
}: {
  items: Array<{ text: string; displayText: string; sublabel: string }>;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  return (
    <div className={`rounded-lg border px-3 py-3 ${theme.border} bg-black/[0.04]`}>
      <p className={`${theme.textMuted} text-[11px] font-light mb-2.5 opacity-90`}>
        {DYNAMICS_COPY.repeatingIntro}
      </p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.text} className="flex gap-2 items-start min-w-0">
            <span className={`${theme.textMuted} text-[13px] opacity-60 shrink-0 pt-0.5`}>•</span>
            <div className="min-w-0 flex-1">
              <p className={`${theme.textSecondary} text-[13px] font-light leading-[1.6] break-words`}>
                {item.displayText}
              </p>
              {item.sublabel === 'returnsHere' ? (
                <p className={`${theme.textMuted} text-[10px] font-light mt-0.5 opacity-75`}>
                  {DYNAMICS_COPY.returnsHere}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TextCard({
  text,
  sublabel,
  theme,
}: {
  text: string;
  sublabel?: string;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${theme.border} bg-black/[0.04]`}>
      {sublabel ? (
        <p className={`${theme.textMuted} text-[10px] font-light mb-1 opacity-75`}>{sublabel}</p>
      ) : null}
      <p className={`${theme.textSecondary} text-[13px] font-light leading-[1.65] whitespace-pre-wrap`}>
        {text}
      </p>
    </div>
  );
}

function WeeklyEntryCard({
  entry,
  busy,
  cardClass,
  theme,
  defaultOpen,
  onSave,
  onDelete,
}: {
  entry: ProgressEntry;
  busy: boolean;
  cardClass: string;
  theme: ReturnType<typeof useTheme>['theme'];
  defaultOpen?: boolean;
  onSave: (content: string) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);

  return (
    <div className={`${cardClass} ${busy ? 'opacity-60' : ''}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-center justify-between gap-2 text-left"
      >
        <span className={`${theme.textPrimary} text-sm font-light min-w-0 truncate`}>
          {formatWeeklyPeriod(entry)}
        </span>
        <ChevronDown
          className={`w-4 h-4 ${theme.textMuted} transition-transform ${open ? 'rotate-180' : ''}`}
          strokeWidth={1.5}
        />
      </button>
      {open && (
        <div className="px-4 pb-3 pt-0 border-t border-opacity-20">
          {editing ? (
            <div className="flex gap-2 mt-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={6}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-light resize-none ${theme.border} ${theme.surface} ${theme.textPrimary} bg-transparent leading-relaxed`}
              />
              <div className="flex flex-col gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    onSave(draft);
                    setEditing(false);
                  }}
                  className={`p-2 rounded-lg ${theme.surfaceHover}`}
                >
                  <Check className={`w-4 h-4 ${theme.textSecondary}`} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(entry.content);
                    setEditing(false);
                  }}
                  className={`p-2 rounded-lg ${theme.surfaceHover}`}
                >
                  <X className={`w-4 h-4 ${theme.textMuted}`} strokeWidth={1.5} />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2 items-start mt-2">
              <p className={`flex-1 ${theme.textSecondary} text-[13px] font-light leading-[1.65] whitespace-pre-wrap`}>
                {entry.content}
              </p>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className={`shrink-0 p-1.5 rounded-lg opacity-60 hover:opacity-100 ${theme.surfaceHover}`}
                aria-label={REFLECTION_COPY.editAria}
              >
                <Pencil className={`w-3.5 h-3.5 ${theme.textMuted}`} strokeWidth={1.5} />
              </button>
              <ConfirmDeleteButton theme={theme} onConfirm={onDelete} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ConversationDynamicsScreen() {
  const { user } = useAuth();
  const {
    currentConversation,
    setCurrentConversation,
    conversations,
    setConversations,
    navigateBack,
    dynamicsReturnScreen,
  } = useApp();
  const { theme } = useTheme();
  const sectionLabel = useSectionLabelClass();

  const fromProfile = dynamicsReturnScreen === 'profile';
  const showHub = !fromProfile && !!currentConversation?.id;

  const [convOptions, setConvOptions] = useState<ConvOption[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(
    fromProfile ? null : (currentConversation?.id ?? null),
  );
  const [convsLoading, setConvsLoading] = useState(fromProfile);
  const [weeklies, setWeeklies] = useState<ProgressEntry[]>([]);
  const [dynamicsData, setDynamicsData] = useState<ConversationDynamicsData | null>(null);
  const [cooldown, setCooldown] = useState<WeeklyCooldownStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [weeklyBusy, setWeeklyBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState({
    latest: true,
    history: false,
    changing: true,
    repeating: false,
    alive: false,
  });

  const convId = fromProfile ? selectedConvId : currentConversation?.id;
  const convTitle =
    conversations.find((c) => c.id === convId)?.title ?? currentConversation?.title;

  const cardBase = [
    'w-full rounded-xl border transition-all duration-300',
    theme.surface,
    theme.border,
  ].join(' ');

  useEffect(() => {
    if (!fromProfile || !user) return;
    async function loadConversations() {
      setConvsLoading(true);
      let list = conversations.filter((c) => c.is_active);
      if (list.length === 0) {
        const { data } = await supabase
          .from('conversations')
          .select('*')
          .eq('user_id', user!.id)
          .eq('is_active', true)
          .order('last_message_at', { ascending: false });
        list = (data ?? []) as Conversation[];
        setConversations(list);
      }
      setConvOptions(list.map((c) => ({ id: c.id, title: c.title || 'Без названия' })));
      const initial = selectedConvId ?? currentConversation?.id ?? list[0]?.id ?? null;
      if (initial) {
        setSelectedConvId(initial);
        const conv = list.find((c) => c.id === initial);
        if (conv) setCurrentConversation(conv);
      }
      setConvsLoading(false);
    }
    void loadConversations();
  }, [fromProfile, user]);

  const load = useCallback(async () => {
    if (!user || !convId) {
      setLoading(false);
      setWeeklies([]);
      setDynamicsData(null);
      setCooldown(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [weeklyRows, memory, tensions, crossMemory, activity, cd] = await Promise.all([
        fetchWeeklyDynamics(user.id, convId),
        fetchConversationMemory(user.id, convId),
        fetchTensionsForConversation(user.id, convId),
        fetchCrossMemoryForUser(user.id),
        fetchMessageActivityForConversation(convId),
        getWeeklyCooldownStatus(convId),
      ]);
      setWeeklies(weeklyRows);
      setCooldown(cd);
      setDynamicsData({
        memory: memory ?? emptyMemory(),
        weeklies: weeklyRows,
        tensions,
        crossMemory,
        messageActivity: activity,
      });
    } catch {
      setError('Не удалось загрузить динамику.');
    } finally {
      setLoading(false);
    }
  }, [user, convId]);

  useEffect(() => {
    void load();
  }, [load]);

  const changing = useMemo(
    () => (dynamicsData ? buildChangingView(dynamicsData) : null),
    [dynamicsData],
  );
  const repeating = useMemo(
    () => (dynamicsData ? buildRepeatingView(dynamicsData) : []),
    [dynamicsData],
  );
  const alive = useMemo(
    () => (dynamicsData ? buildAliveView(dynamicsData) : []),
    [dynamicsData],
  );

  const latestWeekly = weeklies[0] ?? null;
  const historyWeeklies = weeklies.slice(1);

  function toggleSection(key: keyof typeof openSections) {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const showWeeklyTrend =
    weeklies.length >= DYNAMICS_WEEKLY_TREND_MIN_WEEKLIES &&
    changing &&
    !changing.empty &&
    (changing.newItems.length > 0 ||
      changing.fadedItems.length > 0 ||
      changing.repeatedItems.length > 0);

  function aliveSublabel(source: string): string | undefined {
    if (source === 'open_loops') return DYNAMICS_COPY.fromMemory;
    if (source === 'tension') return DYNAMICS_COPY.fromNote;
    return undefined;
  }

  async function handleWeekly() {
    if (!user || !convId) return;
    setWeeklyBusy(true);
    setError(null);
    const result = await saveWeeklyDynamics(user.id, convId, convTitle);
    if (result.ok) {
      await load();
      setOpenSections((prev) => ({ ...prev, latest: true, history: false }));
    } else if (result.reason === 'cooldown') {
      setError(
        `${REFLECTION_COPY.weeklyCooldown}: ${formatNextAvailable(result.nextAvailableAt ?? '')}`,
      );
      const cd = await getWeeklyCooldownStatus(convId);
      setCooldown(cd);
    } else {
      setError('Не удалось создать динамику. Попробуйте чуть позже.');
    }
    setWeeklyBusy(false);
  }

  async function handleUpdateWeekly(id: string, content: string) {
    setBusyId(id);
    const updated = await updateProgressEntry(id, content);
    if (updated) {
      setWeeklies((prev) => prev.map((e) => (e.id === id ? updated : e)));
      await load();
    } else {
      setError('Не удалось сохранить изменения.');
    }
    setBusyId(null);
  }

  async function handleDeleteWeekly(id: string) {
    setBusyId(id);
    const ok = await deleteProgressEntry(id);
    if (ok) {
      if (convId) setCooldown(await getWeeklyCooldownStatus(convId));
      await load();
    }
    setBusyId(null);
  }

  if (!user) return null;

  const weeklyDisabled = weeklyBusy || (cooldown !== null && !cooldown.canCreate);
  const backLabel = dynamicsReturnScreen === 'chat' ? 'К беседе' : 'В контекст';

  return (
    <StickyScreenLayout
      header={(
        <ScreenBackHeader
          pinned
          onBack={() => navigateBack()}
          title={DYNAMICS_COPY.title}
          subtitle={
            fromProfile
              ? 'Динамика только для выбранной беседы'
              : convTitle
                ? `${DYNAMICS_COPY.subtitle} · ${convTitle}`
                : DYNAMICS_COPY.subtitle
          }
          backLabel={backLabel}
        />
      )}
    >
      <p className={`${theme.textMuted} text-xs font-light leading-relaxed mb-4 opacity-90`}>
        {DYNAMICS_COPY.intro}
      </p>

      <ConversationHubNav active="dynamics" show={showHub} />

      {error && (
        <p className="text-red-400/80 text-xs font-light text-center mb-4">{error}</p>
      )}

      {fromProfile && (
        <section className="mb-6">
          <p className={sectionLabel}>Беседа</p>
          {convsLoading ? (
            <div className="flex justify-center py-6">
              <div className={`w-5 h-5 border-2 ${theme.spinnerBorder} ${theme.spinnerTop} rounded-full animate-spin`} />
            </div>
          ) : (
            <ConversationScopePicker
              cardClass={cardBase}
              options={convOptions}
              selectedId={selectedConvId}
              onSelect={(id) => {
                setSelectedConvId(id);
                const conv = conversations.find((c) => c.id === id);
                if (conv) setCurrentConversation(conv);
              }}
            />
          )}
        </section>
      )}

      {!convId ? (
        fromProfile && !convsLoading ? (
          <p className={`${theme.textMuted} text-sm font-light`}>Выберите беседу.</p>
        ) : null
      ) : loading ? (
        <p className={`${theme.textMuted} text-sm font-light`}>{DYNAMICS_COPY.loading}</p>
      ) : (
        <div className="space-y-3 pb-6">
          <section className={`${cardBase} px-4 py-4`}>
            <p className={sectionLabel}>{REFLECTION_COPY.weeklySection}</p>
            <div className={`${theme.textMuted} text-xs font-light leading-relaxed mt-2 mb-3 space-y-1`}>
              {REFLECTION_COPY.weeklyHintLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            {cooldown && !cooldown.canCreate && cooldown.nextAvailableAt && (
              <p className={`${theme.textMuted} text-[11px] font-light mb-3`}>
                {REFLECTION_COPY.weeklyCooldown}{' '}
                {formatNextAvailable(cooldown.nextAvailableAt)}
              </p>
            )}
            <button
              type="button"
              disabled={weeklyDisabled}
              onClick={() => void handleWeekly()}
              className={`w-full py-2.5 rounded-xl border ${theme.btnBg} ${theme.btnBorder} ${theme.btnText} text-sm font-light tracking-wide disabled:opacity-40`}
            >
              {weeklyBusy ? REFLECTION_COPY.weeklyBusy : REFLECTION_COPY.weeklyButton}
            </button>
          </section>

          <CollapsibleBlock
            title={DYNAMICS_COPY.latestWeek}
            meta={latestWeekly ? formatWeeklyPeriod(latestWeekly) : undefined}
            open={openSections.latest}
            onToggle={() => toggleSection('latest')}
            cardClass={cardBase}
            theme={theme}
          >
            {latestWeekly ? (
              <TextCard text={latestWeekly.content} theme={theme} />
            ) : (
              <p className={`${theme.textMuted} text-sm font-light`}>{DYNAMICS_COPY.emptyLatest}</p>
            )}
          </CollapsibleBlock>

          {historyWeeklies.length > 0 && (
            <CollapsibleBlock
              title={DYNAMICS_COPY.weekHistory}
              count={historyWeeklies.length}
              open={openSections.history}
              onToggle={() => toggleSection('history')}
              cardClass={cardBase}
              theme={theme}
            >
              <div className="space-y-2">
                {historyWeeklies.map((entry) => (
                  <WeeklyEntryCard
                    key={entry.id}
                    entry={entry}
                    busy={busyId === entry.id}
                    cardClass={cardBase}
                    theme={theme}
                    onSave={(content) => void handleUpdateWeekly(entry.id, content)}
                    onDelete={() => void handleDeleteWeekly(entry.id)}
                  />
                ))}
              </div>
            </CollapsibleBlock>
          )}

          <CollapsibleBlock
            title={DYNAMICS_COPY.changing}
            open={openSections.changing}
            onToggle={() => toggleSection('changing')}
            cardClass={cardBase}
            theme={theme}
          >
            {changing?.empty ? (
              <p className={`${theme.textMuted} text-sm font-light`}>{DYNAMICS_COPY.emptyChanging}</p>
            ) : showWeeklyTrend ? (
              <div className="space-y-2">
                <TrendGroup
                  direction="up"
                  label={DYNAMICS_COPY.trendUp}
                  items={changing?.newItems ?? []}
                  theme={theme}
                />
                <TrendGroup
                  direction="down"
                  label={DYNAMICS_COPY.trendDown}
                  items={changing?.fadedItems ?? []}
                  theme={theme}
                />
                <TrendGroup
                  direction="repeat"
                  label={DYNAMICS_COPY.trendRepeated}
                  items={changing?.repeatedItems ?? []}
                  theme={theme}
                />
                {changing?.activityText ? (
                  <TextCard text={changing.activityText} sublabel={DYNAMICS_COPY.rhythm} theme={theme} />
                ) : null}
              </div>
            ) : (
              <>
                {changing?.newItems.map((text) => (
                  <TextCard key={`new-${text}`} text={text} sublabel={DYNAMICS_COPY.appeared} theme={theme} />
                ))}
                {changing?.fadedItems.map((text) => (
                  <TextCard key={`fade-${text}`} text={text} sublabel={DYNAMICS_COPY.faded} theme={theme} />
                ))}
                {changing?.repeatedItems.map((text) => (
                  <TextCard key={`rep-${text}`} text={text} sublabel={DYNAMICS_COPY.repeated} theme={theme} />
                ))}
                {changing?.activityText ? (
                  <TextCard text={changing.activityText} sublabel={DYNAMICS_COPY.rhythm} theme={theme} />
                ) : null}
              </>
            )}
          </CollapsibleBlock>

          <CollapsibleBlock
            title={DYNAMICS_COPY.repeating}
            count={repeating.length || undefined}
            open={openSections.repeating}
            onToggle={() => toggleSection('repeating')}
            cardClass={cardBase}
            theme={theme}
          >
            {repeating.length === 0 ? (
              <p className={`${theme.textMuted} text-sm font-light`}>{DYNAMICS_COPY.emptyRepeating}</p>
            ) : (
              <RepeatingThemesList items={repeating} theme={theme} />
            )}
          </CollapsibleBlock>

          <CollapsibleBlock
            title={DYNAMICS_COPY.alive}
            count={alive.length || undefined}
            open={openSections.alive}
            onToggle={() => toggleSection('alive')}
            cardClass={cardBase}
            theme={theme}
            intro={alive.length > 0 ? DYNAMICS_COPY.aliveIntro : undefined}
          >
            {alive.length === 0 ? (
              <p className={`${theme.textMuted} text-sm font-light`}>{DYNAMICS_COPY.emptyAlive}</p>
            ) : (
              alive.map((item) => (
                <TextCard
                  key={`${item.source}-${item.text}`}
                  text={item.text}
                  sublabel={aliveSublabel(item.source)}
                  theme={theme}
                />
              ))
            )}
          </CollapsibleBlock>
        </div>
      )}
    </StickyScreenLayout>
  );
}
