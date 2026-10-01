import { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, ChevronDown, Download, History, Pencil, Plus, Sparkles, Trash2, X, Check } from 'lucide-react';
import { ConversationScopePicker } from '../ConversationScopePicker';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import { ensureUserProfile } from '../../lib/ensureProfile';
import { ConfirmDeleteButton } from '../ConfirmDeleteButton';
import { ConversationHubNav } from '../ConversationHubNav';
import { CrossMemoryToggle } from '../CrossMemoryToggle';
import { ConversationCrossMemoryToggle } from '../ConversationCrossMemoryToggle';
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
import { normalizeMemoryTextForDisplay } from '../../lib/memoryDisplayNormalize';
import {
  deleteMemoryV3Item,
  downloadMemoryV3ExportAsJson,
  exportMemoryV3Data,
  fetchMemoryV3Items,
  type MemoryV3ViewerItem,
} from '../../lib/memoryV3Viewer';
import { downloadMemoryV3ExportAsPdf } from '../../lib/memoryV3ExportPdf';
import {
  isLegacyMemoryCompatibilityEnabled,
  resolveMemoryScreenCapabilities,
} from '../../lib/memoryScreenMode';
import { MemoryV3ItemList } from '../MemoryV3ItemList';
import type { Conversation, UserMemory } from '../../types';

const MEMORY_V3_DIALOGUE_TOPIC_LABELS: Record<string, string> = {
  person: 'Люди',
  fact: 'Факты',
  preference: 'Предпочтения общения',
};

const MEMORY_V3_LIFECYCLE_TOPIC_LABELS: Record<string, string> = {
  life_context: 'Факты профиля',
  communication: 'Стиль общения',
  preference: 'Что помогает в контакте',
};

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

type ConvOption = Pick<Conversation, 'id' | 'title' | 'cross_memory_enabled'>;

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
                        {normalizeMemoryTextForDisplay(item.text)}
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
  const showLegacyCompatibility = isLegacyMemoryCompatibilityEnabled(profile);
  const [memoryV3AccountWide, setMemoryV3AccountWide] = useState<MemoryV3ViewerItem[]>([]);
  const [memoryV3Dialogue, setMemoryV3Dialogue] = useState<MemoryV3ViewerItem[]>([]);
  const {
    currentConversation,
    memoryReturnScreen,
    navigateBack,
  } = useApp();
  const capabilities = resolveMemoryScreenCapabilities(memoryReturnScreen);
  const { theme } = useTheme();
  const sectionLabel = useSectionLabelClass();

  const [convOptions, setConvOptions] = useState<ConvOption[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(
    currentConversation?.id ?? null,
  );
  const [conversationCrossMemoryOn, setConversationCrossMemoryOn] = useState(
    currentConversation?.cross_memory_enabled !== false,
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
  const [exportChoiceOpen, setExportChoiceOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
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
    if (memoryReturnScreen === 'chat' && currentConversation?.id) {
      setSelectedConvId(currentConversation.id);
      setConversationCrossMemoryOn(currentConversation.cross_memory_enabled !== false);
    }
  }, [currentConversation, memoryReturnScreen]);

  const load = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    if (memoryReturnScreen === 'chat' && !currentConversation?.id) {
      setLoading(false);
      navigateBack();
      return;
    }
    setLoading(true);
    let activeConvId: string | null = null;
    try {
      let list: ConvOption[] = [];
      let convId: string | null = currentConversation?.id ?? null;
      if (capabilities.canChooseConversation) {
        const { data: convs, error: conversationsError } = await supabase
          .from('conversations')
          .select('id, title, cross_memory_enabled')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .order('last_message_at', { ascending: false });
        if (conversationsError) throw conversationsError;
        list = (convs ?? []) as ConvOption[];
        setConvOptions(list);
        convId = selectedConvId && list.some((conversation) => conversation.id === selectedConvId)
          ? selectedConvId
          : list[0]?.id ?? null;
      } else {
        setConvOptions([]);
      }

      activeConvId = convId;
      if (selectedConvId !== convId) setSelectedConvId(convId);

      if (convId) {
        const conversationFields = showLegacyCompatibility
          ? 'conversation_summary, cross_memory_enabled'
          : 'cross_memory_enabled';
        const { data, error } = await supabase
          .from('conversations')
          .select(conversationFields)
          .eq('id', convId)
          .eq('user_id', user.id)
          .maybeSingle();
        if (error) throw error;
        if (!data && memoryReturnScreen === 'chat') {
          navigateBack();
          return;
        }
        const conversationData = data as {
          conversation_summary?: string | null;
          cross_memory_enabled?: boolean | null;
        } | null;
        setConversationCrossMemoryOn(conversationData?.cross_memory_enabled !== false);
        const raw = showLegacyCompatibility
          ? (conversationData?.conversation_summary ?? null)
          : null;
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

      if (capabilities.showAccountWideMemory && showLegacyCompatibility) {
        const { data: mem, error: memErr } = await supabase
          .from('user_memory')
          .select('id, user_id, memory_type, content, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });
        if (memErr) throw memErr;
        setGlobalRows((mem ?? []) as UserMemory[]);
      } else {
        setGlobalRows([]);
      }

      const memoryV3 = await fetchMemoryV3Items(activeConvId ?? undefined);
      setMemoryV3AccountWide(
        capabilities.showAccountWideMemory || capabilities.showAccountWidePreview
          ? memoryV3.accountWide
          : [],
      );
      setMemoryV3Dialogue(memoryV3.dialogue);
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
  }, [
    capabilities.canChooseConversation,
    capabilities.showAccountWideMemory,
    capabilities.showAccountWidePreview,
    showLegacyCompatibility,
    currentConversation?.id,
    memoryReturnScreen,
    navigateBack,
    selectedConvId,
    user,
  ]);

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

  async function handleExport(format: 'json' | 'pdf') {
    setExportBusy(true);
    setExportError(null);
    try {
      const result = await exportMemoryV3Data();
      if (result.error) {
        setExportError('Не удалось сохранить. Нажмите ещё раз.');
        return;
      }
      if (format === 'json') {
        downloadMemoryV3ExportAsJson(result);
      } else {
        downloadMemoryV3ExportAsPdf(result);
      }
      setExportChoiceOpen(false);
    } catch {
      setExportError('Не удалось сохранить. Нажмите ещё раз.');
    } finally {
      setExportBusy(false);
    }
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

  async function deleteMemoryV3AccountWideItem(item: MemoryV3ViewerItem) {
    const result = await deleteMemoryV3Item({ scope: 'account_wide', memoryKey: item.memoryKey });
    if (result.deleted) {
      setMemoryV3AccountWide((rows) => rows.filter((row) => row.memoryKey !== item.memoryKey));
    }
  }

  async function deleteMemoryV3DialogueItem(item: MemoryV3ViewerItem) {
    if (!selectedConvId) return;
    const result = await deleteMemoryV3Item({
      scope: 'dialogue', memoryKey: item.memoryKey, conversationId: selectedConvId,
    });
    if (result.deleted) {
      setMemoryV3Dialogue((rows) => rows.filter((row) => row.memoryKey !== item.memoryKey));
    }
  }

  return (
    <StickyScreenLayout
      header={(
        <ScreenBackHeader
          pinned
          onBack={goBack}
          title="Память"
          subtitle={memoryReturnScreen === 'chat'
            ? (currentConversation?.title || 'Эта беседа')
            : 'Факты и беседы'}
          backLabel={memoryReturnScreen === 'chat' ? 'Назад в беседу' : 'В контекст'}
        />
      )}
    >
        <div className={`relative overflow-hidden rounded-2xl border px-5 py-5 mb-6 ${theme.border} ${theme.surface}`}>
          <div className="absolute -right-10 -top-12 h-32 w-32 rounded-full bg-[#c9a96e]/10 blur-2xl" />
          <div className="relative flex items-start gap-3.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#c9a96e]/20 bg-[#c9a96e]/10">
              <Sparkles className="h-4 w-4 text-[#c9a96e]" strokeWidth={1.5} />
            </div>
            <div className="min-w-0 flex-1">
              <p className={`${theme.textPrimary} text-[15px] font-light`}>
                Что помнит StaySee
              </p>
              <p className={`${theme.textMuted} mt-1 text-xs font-light leading-relaxed`}>
                Здесь можно посмотреть сохранённые записи.
              </p>
              {!loading && capabilities.canChooseConversation && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className={`rounded-full border px-2.5 py-1 text-[11px] font-light ${theme.border} ${theme.textSecondary}`}>
                    Эта беседа · {memoryV3Dialogue.length}
                  </span>
                  {(capabilities.showAccountWideMemory || capabilities.showAccountWidePreview) && (
                    <span className={`rounded-full border px-2.5 py-1 text-[11px] font-light ${theme.border} ${theme.textSecondary}`}>
                      Обо мне · {memoryV3AccountWide.length}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <ConversationHubNav active="memory" show={memoryReturnScreen === 'chat' && !!selectedConvId} />

        {loading ? (
          <div className="flex justify-center py-12">
            <div className={`w-6 h-6 border-2 ${theme.spinnerBorder} ${theme.spinnerTop} rounded-full animate-spin`} />
          </div>
        ) : (
          <>
            <div className={`${cardBase} px-4 py-3.5 mb-4`}>
              {!exportChoiceOpen ? (
                <button
                  type="button"
                  onClick={() => setExportChoiceOpen(true)}
                  className={`inline-flex items-center gap-1.5 text-sm font-light ${theme.textSecondary}`}
                >
                  <Download className="w-4 h-4" strokeWidth={1.5} />
                  Скачать мои данные
                </button>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className={`${theme.textMuted} text-xs font-light`}>
                    Выгрузка памяти по всем беседам — выберите формат:
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={exportBusy}
                      onClick={() => void handleExport('pdf')}
                      className={`px-3 py-1.5 rounded-lg text-xs ${theme.surfaceHover} ${theme.textSecondary} disabled:opacity-50`}
                    >
                      PDF
                    </button>
                    <button
                      type="button"
                      disabled={exportBusy}
                      onClick={() => void handleExport('json')}
                      className={`px-3 py-1.5 rounded-lg text-xs ${theme.surfaceHover} ${theme.textSecondary} disabled:opacity-50`}
                    >
                      JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => { setExportChoiceOpen(false); setExportError(null); }}
                      className={`px-3 py-1.5 rounded-lg text-xs ${theme.textMuted}`}
                    >
                      Отмена
                    </button>
                  </div>
                  {exportError && (
                    <p className="text-red-400/80 text-xs font-light">{exportError}</p>
                  )}
                </div>
              )}
            </div>

            <section className="mb-8">
              <p className={sectionLabel}>Память этой беседы</p>
              <p className={`${theme.textMuted} text-xs font-light mb-3 leading-relaxed opacity-85`}>
                Помогает продолжать разговор с учётом сказанного раньше.
              </p>
              {capabilities.canChooseConversation ? (
                <div className="mb-4">
                  <ConversationScopePicker
                    cardClass={cardBase}
                    options={convOptions}
                    selectedId={selectedConvId}
                    onSelect={setSelectedConvId}
                  />
                </div>
              ) : null}

              {capabilities.showConversationControl && selectedConvId && (
                <div className="mb-4">
                  <ConversationCrossMemoryToggle
                    conversationId={selectedConvId}
                    enabled={conversationCrossMemoryOn}
                    profileDefaultEnabled={crossMemoryOn}
                    cardClass={cardBase}
                    onChanged={setConversationCrossMemoryOn}
                  />
                </div>
              )}

              {capabilities.showAccountWidePreview && (
                <div className="mb-4">
                  <p className={sectionLabel}>Сквозная память</p>
                  <p className={`${theme.textMuted} text-xs font-light mb-3 leading-relaxed opacity-85`}>
                    {conversationCrossMemoryOn
                      ? 'Общие факты, которые StaySee учитывает в этой беседе.'
                      : 'Сейчас не используется в этой беседе.'}
                  </p>
                  <details className={`${cardBase} overflow-hidden ${conversationCrossMemoryOn ? '' : 'opacity-70'}`}>
                    <summary className={`cursor-pointer list-none px-4 py-3.5 flex items-center gap-3 ${theme.surfaceHover}`}>
                      <Brain className={`w-4 h-4 ${theme.textMuted} shrink-0`} strokeWidth={1.5} />
                      <span className={`${theme.textSecondary} text-sm font-light flex-1`}>
                        Обо мне · {memoryV3AccountWide.length}
                      </span>
                      <ChevronDown className={`w-4 h-4 ${theme.textMuted}`} strokeWidth={1.5} />
                    </summary>
                    <div className="px-3 pb-3 pt-2">
                      <MemoryV3ItemList
                        items={memoryV3AccountWide}
                        theme={theme}
                        cardBase={cardBase}
                        readOnly
                        emptyMessage="Пока ничего не запомнено."
                        topicLabels={MEMORY_V3_LIFECYCLE_TOPIC_LABELS}
                      />
                    </div>
                  </details>
                </div>
              )}

              {selectedConvId && (
                <div className="space-y-4">
                  <p className={sectionLabel}>Личная память беседы</p>
                  <MemoryV3ItemList
                    items={memoryV3Dialogue}
                    theme={theme}
                    cardBase={cardBase}
                    onDelete={(item) => void deleteMemoryV3DialogueItem(item)}
                    emptyMessage="Пока ничего не запомнено в этой беседе."
                    topicLabels={MEMORY_V3_DIALOGUE_TOPIC_LABELS}
                  />

                  {showLegacyCompatibility && (
                    <details className={`${cardBase} overflow-hidden opacity-80`}>
                      <summary className={`cursor-pointer list-none px-4 py-3.5 flex items-center gap-3 ${theme.surfaceHover}`}>
                        <History className={`w-4 h-4 ${theme.textMuted} shrink-0`} strokeWidth={1.5} />
                        <span className={`${theme.textSecondary} text-sm font-light flex-1`}>
                          Старая память беседы — для сравнения
                        </span>
                        <ChevronDown className={`w-4 h-4 ${theme.textMuted}`} strokeWidth={1.5} />
                      </summary>
                      <div className="space-y-1.5 px-3 pb-3 pt-2">
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
                    </details>
                  )}
                </div>
              )}
            </section>

            {capabilities.showAccountWideMemory && (
            <section>
              <p className={sectionLabel}>Обо мне</p>
              {capabilities.showProfileBulkControl && (
                <div className="mb-3">
                  <CrossMemoryToggle cardClass={cardBase} onChanged={() => void load()} />
                </div>
              )}
              {crossMemoryOn && (
                <p className={`${theme.textMuted} text-xs font-light mb-3 leading-relaxed opacity-85`}>
                  {GLOBAL_MEMORY_HINT}
                </p>
              )}

              <MemoryV3ItemList
                items={memoryV3AccountWide}
                theme={theme}
                cardBase={cardBase}
                onDelete={(item) => void deleteMemoryV3AccountWideItem(item)}
                emptyMessage="Пока ничего не запомнено."
                topicLabels={MEMORY_V3_LIFECYCLE_TOPIC_LABELS}
              />

              {showLegacyCompatibility && (
                <details className={`${cardBase} mt-4 overflow-hidden opacity-80`}>
                  <summary className={`cursor-pointer list-none px-4 py-3.5 flex items-center gap-3 ${theme.surfaceHover}`}>
                    <History className={`w-4 h-4 ${theme.textMuted} shrink-0`} strokeWidth={1.5} />
                    <span className={`${theme.textSecondary} text-sm font-light flex-1`}>
                      Старая сквозная память — для сравнения
                    </span>
                    <ChevronDown className={`w-4 h-4 ${theme.textMuted}`} strokeWidth={1.5} />
                  </summary>
                  <div className="px-3 pb-3 pt-2">
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
              ) : null}

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
                  </div>
                </details>
              )}
            </section>
            )}
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
            {normalizeMemoryTextForDisplay(row.content)}
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
