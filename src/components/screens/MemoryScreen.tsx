import { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, ChevronDown, Pencil, Plus, Trash2, X, Check } from 'lucide-react';
import { ConversationScopePicker } from '../ConversationScopePicker';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import { ensureUserProfile } from '../../lib/ensureProfile';
import { ConfirmDeleteButton } from '../ConfirmDeleteButton';
import { ConversationHubNav } from '../ConversationHubNav';
import { CrossMemoryToggle } from '../CrossMemoryToggle';
import { REFLECTION_COPY } from '../../lib/reflectionCopy';
import { isCrossMemoryEnabled } from '../../lib/profileSettings';
import { ScreenBackHeader, StickyScreenLayout, useSectionLabelClass } from '../layout';
import {
  emptyMemory,
  GLOBAL_MEMORY_HINT,
  GLOBAL_MEMORY_PLACEHOLDER,
  GLOBAL_MEMORY_TYPE_LABELS,
  MEMORY_FIELD_LABELS,
  isEmptyMemoryShell,
  memoryHasContent,
  parseConversationMemory,
  serializeConversationMemory,
  type MemoryFieldKey,
  type StructuredMemory,
} from '../../lib/memoryUi';
import {
  CROSS_MEMORY_DEPRECATED_HINT,
  CROSS_MEMORY_UI_GROUP_LABELS,
  isBlockedCrossMemoryContent,
  partitionCrossMemoryRows,
} from '../../lib/crossMemoryPolicy';
import {
  ADD_FIELD_FOR_SECTION,
  initialSectionOpenState,
  MEMORY_DISPLAY_SECTIONS,
  type MemoryDisplaySectionId,
  type MemoryListItemRef,
} from '../../lib/memoryDisplay';
import {
  collectDisplaySectionItems,
  displayMemoryHasContent,
  legacyRawToDisplayMemory,
  MEMORY_EMPTY_DISPLAY_MESSAGE,
  normalizeMemoryForDisplay,
} from '../../lib/normalizeMemoryForDisplay';
import type { Conversation, UserMemory } from '../../types';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

type ConvOption = Pick<Conversation, 'id' | 'title'>;

function sectionLabelForField(field: MemoryFieldKey): string {
  const section = MEMORY_DISPLAY_SECTIONS.find((s) => ADD_FIELD_FOR_SECTION[s.id] === field);
  return section?.label ?? MEMORY_FIELD_LABELS[field];
}

function ConversationMemoryActions({
  convMemory,
  legacyRaw,
  addField,
  setAddField,
  addDraft,
  setAddDraft,
  onAdd,
  onClear,
  cardBase,
  theme,
}: {
  convMemory: StructuredMemory;
  legacyRaw: string | null;
  addField: MemoryFieldKey | null;
  setAddField: (f: MemoryFieldKey | null) => void;
  addDraft: string;
  setAddDraft: (s: string) => void;
  onAdd: () => void;
  onClear: () => void;
  cardBase: string;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  if (addField) {
    return (
      <div className={`${cardBase} px-4 py-3.5`}>
        <p className={`${theme.textPrimary} text-sm font-light mb-2`}>
          Добавить в «{sectionLabelForField(addField)}»
        </p>
        <input
          value={addDraft}
          onChange={(e) => setAddDraft(e.target.value)}
          placeholder="Короткая формулировка факта"
          className={`w-full rounded-lg border px-3 py-2 text-sm font-light mb-2 ${theme.border} ${theme.surface} ${theme.textPrimary} bg-transparent`}
          autoFocus
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onAdd}
            className={`px-3 py-1.5 rounded-lg text-xs ${theme.surfaceHover} ${theme.textSecondary}`}
          >
            Добавить
          </button>
          <button
            type="button"
            onClick={() => {
              setAddField(null);
              setAddDraft('');
            }}
            className={`px-3 py-1.5 rounded-lg text-xs ${theme.textMuted}`}
          >
            Отмена
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-1 space-y-2">
      <p className={`${theme.textMuted} text-[11px] font-light`}>Добавить в раздел:</p>
      <div className="flex flex-wrap gap-1.5">
        {MEMORY_DISPLAY_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => setAddField(ADD_FIELD_FOR_SECTION[section.id])}
            className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-light ${theme.border} ${theme.surfaceHover} ${theme.textSecondary}`}
          >
            {section.label}
          </button>
        ))}
      </div>
      {(memoryHasContent(convMemory) || legacyRaw) && (
        <ConfirmDeleteButton
          theme={theme}
          onConfirm={onClear}
          confirmPrompt={REFLECTION_COPY.clearMemoryConfirm}
          yesLabel={REFLECTION_COPY.clearMemoryYes}
          className={`px-3 py-2 rounded-lg text-xs ${theme.textMuted}`}
          label={
            <>
              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
              Очистить всё
            </>
          }
        />
      )}
    </div>
  );
}

function CollapsibleMemoryDisplaySection({
  label,
  isOpen,
  onToggle,
  items,
  onChange,
  onRemove,
  cardClass,
  theme,
}: {
  label: string;
  isOpen: boolean;
  onToggle: () => void;
  items: MemoryListItemRef[];
  onChange: (fieldKey: MemoryFieldKey, index: number, value: string) => void;
  onRemove: (fieldKey: MemoryFieldKey, index: number) => void;
  cardClass: string;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (items.length === 0) return null;

  function itemKey(item: MemoryListItemRef) {
    return `${item.fieldKey}:${item.index}`;
  }

  function startEdit(item: MemoryListItemRef) {
    setEditingKey(itemKey(item));
    setDraft(item.text);
  }

  function commitEdit(item: MemoryListItemRef) {
    const v = draft.trim();
    if (v) onChange(item.fieldKey, item.index, v);
    else onRemove(item.fieldKey, item.index);
    setEditingKey(null);
    setDraft('');
  }

  return (
    <div className="space-y-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className={`${cardClass} w-full px-4 py-2.5 flex items-center justify-between gap-3 text-left`}
      >
        <span className={`${theme.textPrimary} text-sm font-light`}>
          {label}
          <span className={`${theme.textMuted} opacity-80`}> · {items.length}</span>
        </span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 ${theme.textMuted} transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          strokeWidth={1.5}
        />
      </button>
      {isOpen && (
        <div className={`${cardClass} border-t-0 rounded-t-none px-4 pb-3 pt-1.5 -mt-px`}>
          <ul className="space-y-1.5">
            {items.map((item) => {
              const key = itemKey(item);
              return (
                <li key={key} className="flex gap-2 items-start">
                  {editingKey === key ? (
                    <div className="flex-1 flex gap-2 min-w-0">
                      <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        className={`flex-1 min-w-0 rounded-lg border px-3 py-2 text-sm font-light ${theme.border} ${theme.surface} ${theme.textPrimary} bg-transparent`}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit(item);
                          if (e.key === 'Escape') setEditingKey(null);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => commitEdit(item)}
                        className={`shrink-0 p-2 rounded-lg ${theme.surfaceHover}`}
                        aria-label="Сохранить"
                      >
                        <Check className={`w-4 h-4 ${theme.textSecondary}`} strokeWidth={1.5} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingKey(null)}
                        className={`shrink-0 p-2 rounded-lg ${theme.surfaceHover}`}
                        aria-label="Отмена"
                      >
                        <X className={`w-4 h-4 ${theme.textMuted}`} strokeWidth={1.5} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <p className={`flex-1 min-w-0 ${theme.textSecondary} text-[13px] font-light leading-[1.65]`}>
                        {item.text}
                      </p>
                      <button
                        type="button"
                        onClick={() => startEdit(item)}
                        className={`shrink-0 p-1.5 rounded-lg opacity-60 hover:opacity-100 ${theme.surfaceHover}`}
                        aria-label="Изменить"
                      >
                        <Pencil className={`w-3.5 h-3.5 ${theme.textMuted}`} strokeWidth={1.5} />
                      </button>
                      <ConfirmDeleteButton
                        theme={theme}
                        onConfirm={() => onRemove(item.fieldKey, item.index)}
                      />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export function MemoryScreen() {
  const { user, profile } = useAuth();
  const crossMemoryOn = isCrossMemoryEnabled(profile);
  const {
    currentConversation,
    memoryReturnScreen,
    navigateBack,
  } = useApp();
  const { theme } = useTheme();
  const sectionLabel = useSectionLabelClass();

  const [convOptions, setConvOptions] = useState<ConvOption[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(
    currentConversation?.id ?? null,
  );
  const [convMemory, setConvMemory] = useState<StructuredMemory | null>(null);
  const [legacyRaw, setLegacyRaw] = useState<string | null>(null);
  const [globalRows, setGlobalRows] = useState<UserMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [convSave, setConvSave] = useState<SaveState>('idle');
  const [globalBusy, setGlobalBusy] = useState<string | null>(null);
  const [addField, setAddField] = useState<MemoryFieldKey | null>(null);
  const [addDraft, setAddDraft] = useState('');
  const [addingGlobal, setAddingGlobal] = useState(false);
  const [globalDraft, setGlobalDraft] = useState('');
  const [memoryWasReset, setMemoryWasReset] = useState(false);
  const [deprecatedOpen, setDeprecatedOpen] = useState(false);
  const [globalSaveError, setGlobalSaveError] = useState<string | null>(null);
  const [sectionOpen, setSectionOpen] = useState(initialSectionOpenState);

  const { active: activeGlobalRows, deprecated: deprecatedGlobalRows } = useMemo(
    () => partitionCrossMemoryRows(globalRows),
    [globalRows],
  );

  const editableSourceMemory = useMemo((): StructuredMemory => {
    if (convMemory) return convMemory;
    if (legacyRaw) return legacyRawToDisplayMemory(legacyRaw);
    return emptyMemory();
  }, [convMemory, legacyRaw]);

  const displayMemory = useMemo(
    () => normalizeMemoryForDisplay(editableSourceMemory),
    [editableSourceMemory],
  );

  const hasDisplayContent = displayMemoryHasContent(displayMemory);

  const cardBase = [
    'w-full rounded-xl border transition-all duration-300',
    theme.surface,
    theme.border,
  ].join(' ');

  function toggleSection(id: MemoryDisplaySectionId) {
    setSectionOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  useEffect(() => {
    if (currentConversation?.id) setSelectedConvId(currentConversation.id);
  }, [currentConversation?.id]);

  const load = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let activeConvId: string | null = null;
    try {
      const { data: convs } = await supabase
        .from('conversations')
        .select('id, title')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('last_message_at', { ascending: false });
      const list = (convs ?? []) as ConvOption[];
      setConvOptions(list);

      const convId = selectedConvId ?? currentConversation?.id ?? list[0]?.id ?? null;
      activeConvId = convId;
      if (!selectedConvId && convId) setSelectedConvId(convId);

      if (convId) {
        const { data, error } = await supabase
          .from('conversations')
          .select('conversation_summary')
          .eq('id', convId)
          .eq('user_id', user.id)
          .maybeSingle();
        if (error) throw error;
        const raw = (data?.conversation_summary as string | null) ?? null;
        const parsed = parseConversationMemory(raw);
        if (parsed) {
          setConvMemory(parsed);
          setLegacyRaw(null);
          setMemoryWasReset(isEmptyMemoryShell(raw));
        } else if (raw?.trim()) {
          setConvMemory(null);
          setLegacyRaw(raw);
        } else {
          setConvMemory(emptyMemory());
          setLegacyRaw(null);
          setMemoryWasReset(false);
        }
      } else {
        setConvMemory(null);
        setLegacyRaw(null);
      }

      const { data: mem, error: memErr } = await supabase
        .from('user_memory')
        .select('id, user_id, memory_type, content, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (memErr) throw memErr;
      setGlobalRows((mem ?? []) as UserMemory[]);
    } catch (err) {
      console.error('[memory] load failed:', err);
      setGlobalRows([]);
      if (activeConvId) {
        setConvMemory(emptyMemory());
        setLegacyRaw(null);
      } else {
        setConvMemory(null);
        setLegacyRaw(null);
      }
    } finally {
      setLoading(false);
    }
  }, [user, selectedConvId, currentConversation?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  function goBack() {
    navigateBack();
  }

  async function saveConversationMemory(next: StructuredMemory | null) {
    if (!user || !selectedConvId) return;
    if (next && !memoryHasContent(next) && convMemory && memoryHasContent(convMemory)) {
      return;
    }
    setConvSave('saving');
    try {
      const payload = next && memoryHasContent(next)
        ? serializeConversationMemory(next)
        : null;
      const { error } = await supabase
        .from('conversations')
        .update({ conversation_summary: payload })
        .eq('id', selectedConvId)
        .eq('user_id', user.id);
      if (error) throw error;
      setConvMemory(next && memoryHasContent(next) ? next : emptyMemory());
      setLegacyRaw(null);
      setConvSave('saved');
      window.setTimeout(() => setConvSave('idle'), 2000);
    } catch {
      setConvSave('error');
    }
  }

  function patchConvField(field: MemoryFieldKey, updater: (arr: string[]) => string[]) {
    const base = editableSourceMemory;
    const next = { ...base, [field]: updater(base[field]) };
    setConvMemory(next);
    setLegacyRaw(null);
    void saveConversationMemory(next);
  }

  function addConvItem() {
    if (!addField || !addDraft.trim()) return;
    patchConvField(addField, (arr) => [...arr, addDraft.trim()]);
    setAddDraft('');
    setAddField(null);
  }

  async function clearConversationMemory() {
    await saveConversationMemory(null);
  }

  async function updateGlobalRow(id: string, content: string) {
    if (!content.trim()) return;
    setGlobalBusy(id);
    try {
      const { error } = await supabase
        .from('user_memory')
        .update({ content: content.trim() })
        .eq('id', id)
        .eq('user_id', user!.id);
      if (error) throw error;
      setGlobalRows((rows) =>
        rows.map((r) => (r.id === id ? { ...r, content: content.trim() } : r)),
      );
    } finally {
      setGlobalBusy(null);
    }
  }

  async function addGlobalMemory() {
    if (!crossMemoryOn || !user || !globalDraft.trim()) return;
    const trimmed = globalDraft.trim();
    if (isBlockedCrossMemoryContent(trimmed)) {
      setGlobalSaveError(
        'Это похоже на динамику беседы, а не на стабильный факт. Оставьте такое в памяти конкретного чата.',
      );
      return;
    }
    setGlobalBusy('new');
    setGlobalSaveError(null);
    try {
      const ensured = await ensureUserProfile(user.id, user.email ?? null);
      if (!ensured.ok) {
        setGlobalSaveError('Не удалось подготовить профиль. Попробуйте выйти и войти снова.');
        return;
      }
      const { data, error } = await supabase
        .from('user_memory')
        .insert({
          user_id: user.id,
          memory_type: 'life_context',
          content: trimmed,
        })
        .select('id, user_id, memory_type, content, created_at')
        .single();
      if (error) throw error;
      setGlobalRows((rows) => [data as UserMemory, ...rows]);
      setGlobalDraft('');
      setAddingGlobal(false);
    } catch {
      setGlobalSaveError('Не удалось сохранить. Проверьте подключение и попробуйте ещё раз.');
    } finally {
      setGlobalBusy(null);
    }
  }

  async function deleteGlobalRow(id: string) {
    setGlobalBusy(id);
    try {
      const { error } = await supabase
        .from('user_memory')
        .delete()
        .eq('id', id)
        .eq('user_id', user!.id);
      if (error) throw error;
      setGlobalRows((rows) => rows.filter((r) => r.id !== id));
    } finally {
      setGlobalBusy(null);
    }
  }

  return (
    <StickyScreenLayout
      header={(
        <ScreenBackHeader
          pinned
          onBack={goBack}
          title="Память"
          subtitle="Что StaySee запоминает о вас и о беседах"
          backLabel={memoryReturnScreen === 'chat' ? 'Назад в беседу' : 'В контекст'}
        />
      )}
    >
        <p className={`${theme.textMuted} text-xs font-light leading-relaxed mb-4 opacity-90`}>
          Память помогает держать общую линию диалога. Вы можете просмотреть, исправить или удалить
          любую запись — AI будет опираться на то, что осталось.
        </p>

        <ConversationHubNav active="memory" show={memoryReturnScreen === 'chat' && !!selectedConvId} />

        {loading ? (
          <div className="flex justify-center py-12">
            <div className={`w-6 h-6 border-2 ${theme.spinnerBorder} ${theme.spinnerTop} rounded-full animate-spin`} />
          </div>
        ) : (
          <>
            <section className="mb-8">
              <p className={sectionLabel}>Память беседы</p>
              <p className={`${theme.textMuted} text-xs font-light mb-3 leading-relaxed opacity-85`}>
                Устойчивые факты и ориентиры по этой беседе — без лишних деталей диалога.
              </p>
              <div className="mb-4">
                <ConversationScopePicker
                  cardClass={cardBase}
                  options={convOptions}
                  selectedId={selectedConvId}
                  onSelect={setSelectedConvId}
                />
              </div>

              {selectedConvId && (
                <>
                <div className="space-y-1.5">
                    {MEMORY_DISPLAY_SECTIONS.map((section) => (
                      <CollapsibleMemoryDisplaySection
                        key={section.id}
                        label={section.label}
                        isOpen={sectionOpen[section.id]}
                        onToggle={() => toggleSection(section.id)}
                        items={collectDisplaySectionItems(
                          editableSourceMemory,
                          ADD_FIELD_FOR_SECTION[section.id],
                        )}
                        cardClass={cardBase}
                        theme={theme}
                        onChange={(fieldKey, i, v) =>
                          patchConvField(fieldKey, (arr) => {
                            const copy = [...arr];
                            copy[i] = v;
                            return copy;
                          })
                        }
                        onRemove={(fieldKey, i) =>
                          patchConvField(fieldKey, (arr) => arr.filter((_, j) => j !== i))
                        }
                      />
                    ))}

                    {!hasDisplayContent && (
                      <div className={`${cardBase} px-4 py-3.5`}>
                        <p className={`${theme.textMuted} text-sm font-light leading-relaxed`}>
                          {memoryWasReset
                            ? 'Память этой беседы была случайно сброшена при обновлении. Сейчас восстанавливаем её из истории сообщений — обновите страницу через минуту или напишите в чат ещё одно сообщение.'
                            : MEMORY_EMPTY_DISPLAY_MESSAGE}
                        </p>
                      </div>
                    )}

                    <ConversationMemoryActions
                      convMemory={editableSourceMemory}
                      legacyRaw={legacyRaw}
                      addField={addField}
                      setAddField={setAddField}
                      addDraft={addDraft}
                      setAddDraft={setAddDraft}
                      onAdd={() => void addConvItem()}
                      onClear={() => void clearConversationMemory()}
                      cardBase={cardBase}
                      theme={theme}
                    />

                    {convSave === 'saving' && (
                      <p className={`${theme.textMuted} text-xs mt-2`}>Сохраняю…</p>
                    )}
                    {convSave === 'saved' && (
                      <p className="text-[#c9a96e]/70 text-xs mt-2">Сохранено</p>
                    )}
                    {convSave === 'error' && (
                      <p className="text-red-400/80 text-xs mt-2">Не удалось сохранить</p>
                    )}
                  </div>
                </>
              )}
            </section>

            <section>
              <p className={sectionLabel}>Сквозная память</p>
              <div className="mb-3">
                <CrossMemoryToggle cardClass={cardBase} />
              </div>
              <p className={`${theme.textMuted} text-xs font-light mb-3 leading-relaxed opacity-85`}>
                {crossMemoryOn
                  ? GLOBAL_MEMORY_HINT
                  : 'Сейчас выключено: в новых сообщениях StaySee не подставляет записи отсюда. Память беседы выше — по-прежнему для этого чата.'}
              </p>

              {addingGlobal && crossMemoryOn ? (
                <div className={`${cardBase} px-4 py-3.5 mb-2`}>
                  <textarea
                    value={globalDraft}
                    onChange={(e) => setGlobalDraft(e.target.value)}
                    rows={3}
                    placeholder={GLOBAL_MEMORY_PLACEHOLDER}
                    className={`w-full rounded-lg border px-3 py-2 text-sm font-light resize-none mb-2 ${theme.border} ${theme.surface} ${theme.textPrimary} bg-transparent`}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void addGlobalMemory()}
                      className={`px-3 py-1.5 rounded-lg text-xs ${theme.surfaceHover} ${theme.textSecondary}`}
                    >
                      Сохранить
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAddingGlobal(false);
                        setGlobalDraft('');
                        setGlobalSaveError(null);
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs ${theme.textMuted}`}
                    >
                      Отмена
                    </button>
                  </div>
                  {globalSaveError && (
                    <p className="text-red-400/80 text-xs mt-2 font-light">{globalSaveError}</p>
                  )}
                </div>
              ) : crossMemoryOn ? (
                <button
                  type="button"
                  onClick={() => setAddingGlobal(true)}
                  className={`mb-3 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-light ${theme.border} ${theme.surfaceHover} ${theme.textSecondary}`}
                >
                  <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />
                  Добавить в сквозную память
                </button>
              ) : (
                <p className={`${theme.textMuted} text-sm font-light mb-3 leading-relaxed`}>
                  Сквозная память выключена — записи ниже не подставляются в новые сообщения.
                </p>
              )}

              {!crossMemoryOn && globalRows.length > 0 && (
                <div className={`${cardBase} px-4 py-4 mb-3 opacity-80`}>
                  <p className={`${theme.textMuted} text-sm font-light leading-relaxed`}>
                    Сохранённые записи (не используются в чате, пока выключено).
                  </p>
                </div>
              )}

              {activeGlobalRows.length === 0 && crossMemoryOn && deprecatedGlobalRows.length === 0 ? (
                <div className={`${cardBase} px-4 py-4 flex gap-3 items-start`}>
                  <Brain className={`w-4 h-4 ${theme.textMuted} shrink-0 mt-0.5`} strokeWidth={1.5} />
                  <p className={`${theme.textMuted} text-sm font-light`}>
                    Пока пусто. Здесь появятся устойчивые факты профиля и предпочтения общения.
                  </p>
                </div>
              ) : activeGlobalRows.length > 0 ? (
                <div className={`space-y-4 ${!crossMemoryOn ? 'opacity-75' : ''}`}>
                  {(['life_context', 'communication', 'preference'] as const).map((groupType) => {
                    const rows = activeGlobalRows.filter((r) => r.memory_type === groupType);
                    if (!rows.length) return null;
                    return (
                      <div key={groupType} className="space-y-1.5">
                        <p className={`${theme.textMuted} text-[11px] font-light px-1 opacity-80`}>
                          {CROSS_MEMORY_UI_GROUP_LABELS[groupType]}
                        </p>
                        {rows.map((row) => (
                          <GlobalMemoryRow
                            key={row.id}
                            row={row}
                            busy={globalBusy === row.id}
                            cardClass={cardBase}
                            theme={theme}
                            readOnly={!crossMemoryOn}
                            onSave={(content) => void updateGlobalRow(row.id, content)}
                            onDelete={() => void deleteGlobalRow(row.id)}
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {deprecatedGlobalRows.length > 0 && (
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => setDeprecatedOpen((v) => !v)}
                    className={`${cardBase} w-full px-4 py-3 text-left flex items-center justify-between`}
                  >
                    <span className={`${theme.textMuted} text-sm font-light`}>
                      Устаревшие записи · {deprecatedGlobalRows.length}
                    </span>
                    <span className={`${theme.textMuted} text-xs`}>{deprecatedOpen ? 'Свернуть' : 'Показать'}</span>
                  </button>
                  {deprecatedOpen && (
                    <div className={`${cardBase} border-t-0 rounded-t-none px-4 pb-4 pt-2 -mt-px space-y-2 opacity-80`}>
                      <p className={`${theme.textMuted} text-xs font-light leading-relaxed`}>
                        {CROSS_MEMORY_DEPRECATED_HINT}
                      </p>
                      {deprecatedGlobalRows.map((row) => (
                        <GlobalMemoryRow
                          key={row.id}
                          row={row}
                          busy={globalBusy === row.id}
                          cardClass={cardBase}
                          theme={theme}
                          readOnly={!crossMemoryOn}
                          deprecated
                          onSave={(content) => void updateGlobalRow(row.id, content)}
                          onDelete={() => void deleteGlobalRow(row.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}
    </StickyScreenLayout>
  );
}

function GlobalMemoryRow({
  row,
  busy,
  cardClass,
  theme,
  readOnly,
  deprecated,
  onSave,
  onDelete,
}: {
  row: UserMemory;
  busy: boolean;
  cardClass: string;
  theme: ReturnType<typeof useTheme>['theme'];
  readOnly?: boolean;
  deprecated?: boolean;
  onSave: (content: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.content);

  return (
    <div className={`${cardClass} px-4 py-3.5 ${busy ? 'opacity-60' : ''}`}>
      <p className={`${theme.textMuted} text-[10px] uppercase tracking-wider mb-1.5 opacity-75`}>
        {deprecated
          ? 'Не используется в чате'
          : (CROSS_MEMORY_UI_GROUP_LABELS[row.memory_type]
            ?? GLOBAL_MEMORY_TYPE_LABELS[row.memory_type]
            ?? row.memory_type)}
      </p>
      {editing ? (
        <div className="flex gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-light resize-none ${theme.border} ${theme.surface} ${theme.textPrimary} bg-transparent`}
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
                setDraft(row.content);
                setEditing(false);
              }}
              className={`p-2 rounded-lg ${theme.surfaceHover}`}
            >
              <X className={`w-4 h-4 ${theme.textMuted}`} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 items-start">
          <p className={`flex-1 ${theme.textSecondary} text-[13px] font-light leading-[1.65]`}>
            {row.content}
          </p>
          {!readOnly && (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className={`shrink-0 p-1.5 rounded-lg opacity-60 hover:opacity-100 ${theme.surfaceHover}`}
              >
                <Pencil className={`w-3.5 h-3.5 ${theme.textMuted}`} strokeWidth={1.5} />
              </button>
              <ConfirmDeleteButton theme={theme} onConfirm={onDelete} disabled={busy} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
