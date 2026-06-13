import { useCallback, useEffect, useState } from 'react';
import { Check, Feather, Pencil, Plus, X } from 'lucide-react';
import { ConfirmDeleteButton } from '../ConfirmDeleteButton';
import { ConversationHubNav } from '../ConversationHubNav';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import { REFLECTION_COPY, type SelfNoteKind } from '../../lib/reflectionCopy';
import { ConversationScopePicker } from '../ConversationScopePicker';
import type { Conversation } from '../../types';
import {
  addSelfNote,
  deleteProgressEntry,
  fetchSelfNotes,
  filterInsightNotes,
  filterTensionNotes,
  type NotesTab,
  updateProgressEntry,
  type ProgressEntry,
} from '../../lib/progressDiary';
import { ScreenBackHeader, StickyScreenLayout, useSectionLabelClass } from '../layout';

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

function NoteEntryRow({
  entry,
  metaLabel,
  busy,
  cardClass,
  theme,
  onSave,
  onDelete,
}: {
  entry: ProgressEntry;
  metaLabel: string;
  busy: boolean;
  cardClass: string;
  theme: ReturnType<typeof useTheme>['theme'];
  onSave: (content: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);

  useEffect(() => {
    if (!editing) setDraft(entry.content);
  }, [entry.content, editing]);

  return (
    <div className={`${cardClass} px-4 py-3.5 ${busy ? 'opacity-60' : ''}`}>
      <p className={`${theme.textMuted} text-[10px] uppercase tracking-wider mb-1.5 opacity-75`}>
        {metaLabel}
      </p>
      {editing ? (
        <div className="flex gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-light resize-none ${theme.border} ${theme.surface} ${theme.textPrimary} bg-transparent leading-relaxed`}
          />
          <div className="flex flex-col gap-1 shrink-0">
            <button
              type="button"
              disabled={!draft.trim()}
              onClick={() => {
                onSave(draft);
                setEditing(false);
              }}
              className={`p-2 rounded-lg ${theme.surfaceHover} disabled:opacity-40`}
              aria-label={REFLECTION_COPY.saveAria}
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
              aria-label={REFLECTION_COPY.deleteCancel}
            >
              <X className={`w-4 h-4 ${theme.textMuted}`} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 items-start">
          <p className={`flex-1 min-w-0 ${theme.textSecondary} text-[13px] font-light leading-[1.65] whitespace-pre-wrap`}>
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
  );
}

function WriteNoteSheet({
  open,
  noteKind,
  draft,
  saving,
  theme,
  onClose,
  onKindChange,
  onDraftChange,
  onSave,
}: {
  open: boolean;
  noteKind: SelfNoteKind;
  draft: string;
  saving: boolean;
  theme: ReturnType<typeof useTheme>['theme'];
  onClose: () => void;
  onKindChange: (kind: SelfNoteKind) => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
}) {
  const [textareaFocused, setTextareaFocused] = useState(false);
  const hasDraft = draft.trim().length > 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) setTextareaFocused(false);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col pointer-events-none">
      <button
        type="button"
        className="pointer-events-auto flex-1 min-h-0 bg-black/55 backdrop-blur-md"
        aria-label={REFLECTION_COPY.sheetCloseAria}
        onClick={onClose}
      />
      <div
        className={`
          pointer-events-auto shrink-0 mx-auto w-[calc(100%-1.5rem)] sm:w-full max-w-[720px]
          overflow-y-auto rounded-t-3xl border-t border-opacity-40 ${theme.border} ${theme.surface}
          px-6 pt-7 pb-8 sm:px-10 sm:pt-9 sm:pb-10 animate-fade-in
        `}
        style={{
          boxShadow: '0 -12px 48px rgba(0,0,0,0.32)',
          maxHeight: 'min(80dvh, 620px)',
          marginBottom: 'calc(5.25rem + env(safe-area-inset-bottom, 0px) + 10dvh)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="flex items-start gap-3 min-w-0">
            <Feather
              className={`w-[18px] h-[18px] sm:w-5 sm:h-5 shrink-0 mt-1 text-[#c9a96e]/45`}
              strokeWidth={1.5}
              aria-hidden
            />
            <h2 className={`${theme.textPrimary} text-lg sm:text-xl font-light tracking-tight leading-snug`}>
              {REFLECTION_COPY.writeSection}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`shrink-0 p-2 rounded-xl opacity-70 hover:opacity-100 ${theme.surfaceHover}`}
            aria-label={REFLECTION_COPY.sheetCloseAria}
          >
            <X className={`w-4 h-4 ${theme.textMuted}`} strokeWidth={1.5} />
          </button>
        </div>

        <p className={`${theme.textSecondary} text-sm font-light leading-[1.75] mb-7 opacity-90`}>
          {REFLECTION_COPY.writeHint}
        </p>

        <div className="flex gap-3 mb-7">
          {(['insight', 'tension'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => onKindChange(kind)}
              className={`
                flex-1 py-2.5 rounded-xl border text-sm font-light outline-none
                focus:outline-none focus-visible:outline-none focus-visible:ring-0
                transition-colors duration-500
                ${noteKind === kind
                  ? `border-[#c9a96e]/22 bg-[#c9a96e]/5 ${theme.textPrimary}`
                  : `${theme.border} border-opacity-30 ${theme.textSecondary} opacity-75 hover:opacity-100`}
              `}
            >
              {kind === 'insight' ? REFLECTION_COPY.insight : REFLECTION_COPY.tension}
            </button>
          ))}
        </div>

        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onFocus={() => setTextareaFocused(true)}
          onBlur={() => setTextareaFocused(false)}
          rows={6}
          placeholder={
            noteKind === 'insight'
              ? REFLECTION_COPY.insightPlaceholder
              : REFLECTION_COPY.tensionPlaceholder
          }
          className={`
            w-full min-h-[170px] rounded-2xl border px-5 py-4
            ${theme.inputBg} ${theme.inputText} ${theme.inputPlaceholder} placeholder:opacity-[0.78]
            font-light text-[15px] leading-[1.75] resize-none outline-none opacity-100
            transition-[border-color,box-shadow] duration-500
            ${textareaFocused
              ? 'border-[#c9a96e]/22 shadow-[0_0_32px_10px_rgba(201,169,110,0.05),0_0_64px_18px_rgba(201,169,110,0.03)]'
              : `${theme.border} border-opacity-30 shadow-none`}
          `}
        />

        <button
          type="button"
          disabled={saving || !hasDraft}
          onClick={onSave}
          className={`
            mt-9 w-full py-3.5 sm:py-4 rounded-xl border text-[15px] font-light tracking-wide
            outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0
            transition-colors duration-500
            ${hasDraft && !saving
              ? `${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover} ${theme.btnText} focus-visible:border-[#c9a96e]/30 shadow-[inset_0_1px_18px_rgba(201,169,110,0.07),inset_0_-8px_24px_rgba(201,169,110,0.03)]`
              : `${theme.surface} ${theme.border} border-opacity-30 ${theme.textSecondary} opacity-55`}
            ${saving ? 'opacity-50' : ''}
          `}
        >
          {saving
            ? REFLECTION_COPY.saving
            : noteKind === 'insight'
              ? REFLECTION_COPY.saveInsight
              : REFLECTION_COPY.saveTension}
        </button>
      </div>
    </div>
  );
}

/** Закреплённая нижняя панель — «+» всегда на виду, как нижняя шапка. */
function NotesBottomBar({
  theme,
  onWrite,
}: {
  theme: ReturnType<typeof useTheme>['theme'];
  onWrite: () => void;
}) {
  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-[60] border-t ${theme.border} border-opacity-35`}
      style={{
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        background: `linear-gradient(to top, ${theme.bgHex}fa, ${theme.bgHex}ee)`,
        paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
      }}
    >
      <div className="flex items-center justify-center py-3 px-5">
        <button
          type="button"
          onClick={onWrite}
          className={`
            w-14 h-14 rounded-full border shadow-lg
            flex items-center justify-center transition-all duration-300 active:scale-95
            ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover}
          `}
          aria-label={REFLECTION_COPY.fabAria}
        >
          <Plus className={`w-6 h-6 ${theme.btnText}`} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}

export function ConversationNotesScreen() {
  const { user } = useAuth();
  const {
    currentConversation,
    setCurrentConversation,
    conversations,
    setConversations,
    navigateBack,
    notesReturnScreen,
    notesCaptureLaunch,
    setNotesCaptureLaunch,
  } = useApp();
  const { theme } = useTheme();
  const sectionLabel = useSectionLabelClass();

  const fromProfile = notesReturnScreen === 'profile';

  const [convOptions, setConvOptions] = useState<{ id: string; title: string }[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(
    fromProfile ? null : (currentConversation?.id ?? null),
  );
  const [convsLoading, setConvsLoading] = useState(fromProfile);

  const [notes, setNotes] = useState<ProgressEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [noteKind, setNoteKind] = useState<SelfNoteKind>('insight');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notesTab, setNotesTab] = useState<NotesTab>('insight');
  const [writeSheetOpen, setWriteSheetOpen] = useState(false);

  const convId = fromProfile ? selectedConvId : currentConversation?.id;
  const convTitle =
    conversations.find((c) => c.id === convId)?.title
    ?? currentConversation?.title;

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
          .eq('user_id', user.id)
          .eq('is_active', true)
          .order('last_message_at', { ascending: false });
        list = (data ?? []) as Conversation[];
        setConversations(list);
      }
      setConvOptions(
        list.map((c) => ({ id: c.id, title: c.title || 'Без названия' })),
      );
      const initial =
        selectedConvId
        ?? currentConversation?.id
        ?? list[0]?.id
        ?? null;
      if (initial) {
        setSelectedConvId(initial);
        const conv = list.find((c) => c.id === initial);
        if (conv) setCurrentConversation(conv);
      }
      setConvsLoading(false);
    }

    void loadConversations();
  }, [fromProfile, user]);

  function handleSelectConversation(id: string) {
    setSelectedConvId(id);
    const conv = conversations.find((c) => c.id === id);
    if (conv) setCurrentConversation(conv);
  }

  const load = useCallback(async () => {
    if (!user || !convId) {
      setLoading(false);
      setNotes([]);
      return;
    }
    setLoading(true);
    const noteRows = await fetchSelfNotes(user.id, convId);
    setNotes(noteRows);
    setLoading(false);
  }, [user, convId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notesCaptureLaunch) return;
    setDraft(notesCaptureLaunch.draft);
    setNoteKind(notesCaptureLaunch.kind);
    setNotesTab(notesCaptureLaunch.kind);
    setWriteSheetOpen(true);
    setNotesCaptureLaunch(null);
  }, [notesCaptureLaunch, setNotesCaptureLaunch]);

  const notesBackLabel = notesReturnScreen === 'chat' ? 'К беседе' : 'В контекст';

  function goBack() {
    navigateBack();
  }

  function openWriteSheet(kind: SelfNoteKind = 'insight') {
    setNoteKind(kind);
    setError(null);
    setWriteSheetOpen(true);
  }

  async function handleSaveNote() {
    if (!user || !convId || !draft.trim()) return;
    setSaving(true);
    setError(null);
    const row = await addSelfNote(user.id, convId, draft, noteKind);
    if (row) {
      setDraft('');
      setNotes((prev) => [row, ...prev]);
      setNotesTab(noteKind);
      setWriteSheetOpen(false);
    } else {
      setError('Не удалось сохранить. Попробуйте ещё раз.');
    }
    setSaving(false);
  }

  async function handleUpdate(id: string, content: string) {
    setBusyId(id);
    setError(null);
    const updated = await updateProgressEntry(id, content);
    if (updated) {
      setNotes((prev) => prev.map((e) => (e.id === id ? updated : e)));
    } else {
      setError('Не удалось сохранить изменения.');
    }
    setBusyId(null);
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    const ok = await deleteProgressEntry(id);
    if (ok) {
      setNotes((prev) => prev.filter((e) => e.id !== id));
    }
    setBusyId(null);
  }

  if (!user) {
    return null;
  }

  const insightNotes = filterInsightNotes(notes);
  const tensionNotes = filterTensionNotes(notes);

  const tabs: { id: NotesTab; label: string; count: number }[] = [
    { id: 'insight', label: REFLECTION_COPY.tabInsight, count: insightNotes.length },
    { id: 'tension', label: REFLECTION_COPY.tabTension, count: tensionNotes.length },
  ];

  const openWrite = () => openWriteSheet(notesTab === 'tension' ? 'tension' : 'insight');

  return (
    <>
      <StickyScreenLayout
        header={(
          <ScreenBackHeader
            pinned
            onBack={goBack}
            title={REFLECTION_COPY.title}
            subtitle={
              fromProfile
                ? 'Записки только для выбранной беседы'
                : convTitle
                  ? `${REFLECTION_COPY.subtitle} · ${convTitle}`
                  : REFLECTION_COPY.subtitle
            }
            backLabel={notesBackLabel}
          />
        )}
      >
        {error && (
          <p className="text-red-400/80 text-xs font-light text-center mb-4">{error}</p>
        )}

        {fromProfile && (
          <section className="mb-6">
            <p className={sectionLabel}>Беседа</p>
            <p className={`${theme.textMuted} text-xs font-light mb-3 leading-relaxed opacity-85`}>
              Инсайты и напряжения — отдельно в каждом чате.
            </p>
            {convsLoading ? (
              <div className="flex justify-center py-6">
                <div className={`w-5 h-5 border-2 ${theme.spinnerBorder} ${theme.spinnerTop} rounded-full animate-spin`} />
              </div>
            ) : (
              <ConversationScopePicker
                cardClass={cardBase}
                options={convOptions}
                selectedId={selectedConvId}
                onSelect={handleSelectConversation}
              />
            )}
          </section>
        )}

        {!convId ? (
          fromProfile && !convsLoading ? (
            <p className={`${theme.textMuted} text-sm font-light leading-relaxed`}>
              Выберите беседу — ниже появятся записки.
            </p>
          ) : null
        ) : (
          <>
        <ConversationHubNav active="notes" show={!fromProfile && !!convId} />
        <p className={sectionLabel}>{REFLECTION_COPY.notesSection}</p>

        <div
          className={`sticky top-0 z-10 -mx-5 px-5 sm:-mx-6 sm:px-6 py-2 mb-4 mt-2 flex gap-1.5 border-b ${theme.border} border-opacity-25`}
          style={{ background: `${theme.bgHex}f2`, backdropFilter: 'blur(8px)' }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setNotesTab(tab.id)}
              className={`
                flex-1 min-w-0 py-2 px-1 rounded-xl border text-xs sm:text-sm font-light transition-all
                ${notesTab === tab.id
                  ? `${theme.btnBg} ${theme.btnBorder} ${theme.textPrimary}`
                  : `${theme.surface} ${theme.border} ${theme.textMuted}`}
              `}
            >
              <span className="block truncate">{tab.label}</span>
              {tab.count > 0 && (
                <span className="block text-[10px] opacity-70">{tab.count}</span>
              )}
            </button>
          ))}
        </div>

        <div className="pb-[calc(5.5rem+env(safe-area-inset-bottom,0px))]">
          {loading ? (
            <p className={`${theme.textMuted} text-sm font-light`}>{REFLECTION_COPY.loading}</p>
          ) : notesTab === 'insight' ? (
            insightNotes.length === 0 ? (
              <div className="space-y-3">
                <p className={`${theme.textMuted} text-sm font-light leading-relaxed`}>
                  {REFLECTION_COPY.emptyInsight}
                </p>
                <button
                  type="button"
                  onClick={() => openWriteSheet('insight')}
                  className={`w-full py-2.5 rounded-xl border ${theme.surface} ${theme.border} ${theme.textSecondary} text-sm font-light`}
                >
                  {REFLECTION_COPY.emptyWriteInsight}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {insightNotes.map((e) => (
                  <NoteEntryRow
                    key={e.id}
                    entry={e}
                    metaLabel={formatDateLong(e.created_at)}
                    busy={busyId === e.id}
                    cardClass={cardBase}
                    theme={theme}
                    onSave={(content) => void handleUpdate(e.id, content)}
                    onDelete={() => void handleDelete(e.id)}
                  />
                ))}
              </div>
            )
          ) : notesTab === 'tension' ? (
            tensionNotes.length === 0 ? (
              <div className="space-y-3">
                <p className={`${theme.textMuted} text-sm font-light leading-relaxed`}>
                  {REFLECTION_COPY.emptyTension}
                </p>
                <button
                  type="button"
                  onClick={() => openWriteSheet('tension')}
                  className={`w-full py-2.5 rounded-xl border ${theme.surface} ${theme.border} ${theme.textSecondary} text-sm font-light`}
                >
                  {REFLECTION_COPY.emptyWriteTension}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {tensionNotes.map((e) => (
                  <NoteEntryRow
                    key={e.id}
                    entry={e}
                    metaLabel={formatDateLong(e.created_at)}
                    busy={busyId === e.id}
                    cardClass={cardBase}
                    theme={theme}
                    onSave={(content) => void handleUpdate(e.id, content)}
                    onDelete={() => void handleDelete(e.id)}
                  />
                ))}
              </div>
            )
          ) : null}
        </div>
          </>
        )}
      </StickyScreenLayout>

      {convId && <NotesBottomBar theme={theme} onWrite={openWrite} />}

      {convId && (
      <WriteNoteSheet
        open={writeSheetOpen}
        noteKind={noteKind}
        draft={draft}
        saving={saving}
        theme={theme}
        onClose={() => {
          setWriteSheetOpen(false);
          setDraft('');
        }}
        onKindChange={setNoteKind}
        onDraftChange={setDraft}
        onSave={() => void handleSaveNote()}
      />
      )}
    </>
  );
}
