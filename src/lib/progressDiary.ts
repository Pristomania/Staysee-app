import { supabase } from './supabase';
import { REFLECTION_ENTRY_LABELS } from './reflectionCopy';
import type { SelfNoteKind } from './reflectionCopy';
import { requestWeeklyReflection } from './weeklyReflection';

export type ProgressEntryType =
  | 'insight'
  | 'tension'
  | 'weekly'
  | 'note'
  | 'shift'
  | 'step';

export interface ProgressEntry {
  id: string;
  user_id: string;
  entry_date: string;
  entry_type: ProgressEntryType;
  content: string;
  conversation_id: string | null;
  created_at: string;
}

const WEEKLY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const NOTE_TYPES: ProgressEntryType[] = ['insight', 'tension', 'note', 'shift', 'step'];
const LEGACY_INSIGHT_TYPES: ProgressEntryType[] = ['note', 'shift', 'step'];

export type NotesTab = 'insight' | 'tension';

/** @deprecated use NotesTab */
export type ArchiveTab = NotesTab;

export function isInsightEntry(type: ProgressEntryType | string): boolean {
  return type === 'insight' || LEGACY_INSIGHT_TYPES.includes(type as ProgressEntryType);
}

export function isTensionEntry(type: ProgressEntryType | string): boolean {
  return type === 'tension';
}

export function filterInsightNotes(entries: ProgressEntry[]): ProgressEntry[] {
  return entries.filter((e) => isInsightEntry(e.entry_type));
}

export function filterTensionNotes(entries: ProgressEntry[]): ProgressEntry[] {
  return entries.filter((e) => isTensionEntry(e.entry_type));
}

export function progressEntryLabel(type: ProgressEntryType | string): string {
  return REFLECTION_ENTRY_LABELS[type] ?? REFLECTION_ENTRY_LABELS.note;
}

export function isSelfNoteType(type: ProgressEntryType | string): boolean {
  return type !== 'weekly';
}

export interface WeeklyCooldownStatus {
  canCreate: boolean;
  lastCreatedAt: string | null;
  nextAvailableAt: string | null;
}

export async function getWeeklyCooldownStatus(
  conversationId: string,
): Promise<WeeklyCooldownStatus> {
  const { data } = await supabase
    .from('progress_entries')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('entry_type', 'weekly')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastCreatedAt = data?.created_at ?? null;
  if (!lastCreatedAt) {
    return { canCreate: true, lastCreatedAt: null, nextAvailableAt: null };
  }

  const lastMs = Date.parse(lastCreatedAt);
  const nextMs = lastMs + WEEKLY_COOLDOWN_MS;
  const canCreate = Date.now() >= nextMs;

  return {
    canCreate,
    lastCreatedAt,
    nextAvailableAt: canCreate ? null : new Date(nextMs).toISOString(),
  };
}

export async function fetchSelfNotes(
  userId: string,
  conversationId: string,
): Promise<ProgressEntry[]> {
  const { data, error } = await supabase
    .from('progress_entries')
    .select('id, user_id, entry_date, entry_type, content, conversation_id, created_at')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .in('entry_type', NOTE_TYPES)
    .order('created_at', { ascending: false })
    .limit(80);

  if (error) {
    console.error('[reflection] notes fetch:', error.message);
    return [];
  }
  return (data ?? []) as ProgressEntry[];
}

export async function fetchWeeklyDynamics(
  userId: string,
  conversationId: string,
): Promise<ProgressEntry[]> {
  const { data, error } = await supabase
    .from('progress_entries')
    .select('id, user_id, entry_date, entry_type, content, conversation_id, created_at')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .eq('entry_type', 'weekly')
    .order('created_at', { ascending: false })
    .limit(52);

  if (error) {
    console.error('[reflection] weekly fetch:', error.message);
    return [];
  }
  return (data ?? []) as ProgressEntry[];
}

export async function addSelfNote(
  userId: string,
  conversationId: string,
  content: string,
  kind: SelfNoteKind,
): Promise<ProgressEntry | null> {
  return addProgressNote(userId, conversationId, content, kind);
}

export async function addProgressNote(
  userId: string,
  conversationId: string,
  content: string,
  entryType: ProgressEntryType = 'insight',
): Promise<ProgressEntry | null> {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const { data, error } = await supabase
    .from('progress_entries')
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      content: trimmed,
      entry_type: entryType,
      entry_date: new Date().toISOString().slice(0, 10),
    })
    .select()
    .single();

  if (error) {
    console.error('[reflection] insert:', error.message);
    return null;
  }
  return data as ProgressEntry;
}

export async function updateProgressEntry(
  id: string,
  content: string,
): Promise<ProgressEntry | null> {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const { data, error } = await supabase
    .from('progress_entries')
    .update({ content: trimmed })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('[reflection] update:', error.message);
    return null;
  }
  return data as ProgressEntry;
}

export async function deleteProgressEntry(id: string): Promise<boolean> {
  const { error } = await supabase.from('progress_entries').delete().eq('id', id);
  if (error) {
    console.error('[reflection] delete:', error.message);
    return false;
  }
  return true;
}

export interface WeeklySnapshot {
  text: string;
  activeDays: number;
  messageCount: number;
}

const MIN_USER_MESSAGE_CHARS = 2;

function dayWordRu(n: number): string {
  if (n === 1) return 'день';
  if (n >= 2 && n <= 4) return 'дня';
  return 'дней';
}

function weeklyToneLine(activeDays: number, substantiveCount: number): string {
  if (substantiveCount === 0) {
    return 'За неделю здесь было тихо — и это тоже может быть опорой.';
  }
  if (substantiveCount <= 2) {
    return 'Совсем немного ваших слов — пара реплик. Можно оглянуться без спешки, что откликается сейчас.';
  }
  if (substantiveCount <= 8) {
    return 'Было несколько ваших реплик — зато своих. Не цифры важны, а то, что вы для себя уносите.';
  }
  if (activeDays <= 2) {
    return 'Вы заглядывали сюда изредка — можно заметить, что менялось по ощущению.';
  }
  return 'Вы возвращались в это пространство — важнее не счёт, а то, что откликается сейчас.';
}

function weeklyPresenceLine(title: string, activeDays: number, substantiveCount: number): string {
  if (activeDays === 0) {
    return `В «${title}» за последние семь дней вы сюда не заглядывали.`;
  }
  const days = dayWordRu(activeDays);
  if (substantiveCount <= 2) {
    return `В «${title}» за семь дней вы заглядывали ${activeDays} ${days} — совсем немного своих слов.`;
  }
  if (substantiveCount <= 8) {
    return `В «${title}» за семь дней вы бывали ${activeDays} ${days} — несколько ваших реплик.`;
  }
  return `В «${title}» за семь дней вы бывали ${activeDays} ${days}.`;
}

export async function buildWeeklySnapshotForConversation(
  _userId: string,
  conversationId: string,
  conversationTitle?: string | null,
): Promise<WeeklySnapshot> {
  const since = new Date();
  since.setDate(since.getDate() - 7);
  since.setHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();

  const { data: msgs, error } = await supabase
    .from('messages')
    .select('created_at, sender, content')
    .eq('conversation_id', conversationId)
    .eq('sender', 'user')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[reflection] weekly messages:', error.message);
  }

  const activeDaysSet = new Set<string>();
  const seenDayContent = new Set<string>();
  let substantiveCount = 0;

  for (const m of msgs ?? []) {
    const text = (m.content ?? '').trim();
    if (text.length < MIN_USER_MESSAGE_CHARS) continue;
    const day = m.created_at.slice(0, 10);
    const dedupeKey = `${day}|${text}`;
    if (seenDayContent.has(dedupeKey)) continue;
    seenDayContent.add(dedupeKey);
    substantiveCount++;
    activeDaysSet.add(day);
  }

  const activeDays = activeDaysSet.size;
  const title = conversationTitle?.trim() || 'эта беседа';

  return {
    text: [
      weeklyPresenceLine(title, activeDays, substantiveCount),
      weeklyToneLine(activeDays, substantiveCount),
    ].join('\n'),
    activeDays,
    messageCount: substantiveCount,
  };
}

export type SaveWeeklyResult =
  | { ok: true; entry: ProgressEntry }
  | { ok: false; reason: 'cooldown' | 'failed'; nextAvailableAt?: string | null };

export async function saveWeeklyDynamics(
  userId: string,
  conversationId: string,
  conversationTitle?: string | null,
): Promise<SaveWeeklyResult> {
  const cooldown = await getWeeklyCooldownStatus(conversationId);
  if (!cooldown.canCreate) {
    return {
      ok: false,
      reason: 'cooldown',
      nextAvailableAt: cooldown.nextAvailableAt,
    };
  }

  const ai = await requestWeeklyReflection(conversationId, userId);
  const snap = ai.text
    ? { text: ai.text, activeDays: 0, messageCount: 0 }
    : await buildWeeklySnapshotForConversation(
        userId,
        conversationId,
        conversationTitle,
      );

  const { data, error } = await supabase
    .from('progress_entries')
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      content: snap.text,
      entry_type: 'weekly',
      entry_date: new Date().toISOString().slice(0, 10),
    })
    .select()
    .single();

  if (error) {
    console.error('[reflection] weekly insert:', error.message);
    return { ok: false, reason: 'failed' };
  }
  return { ok: true, entry: data as ProgressEntry };
}

/** @deprecated Use saveWeeklyDynamics */
export async function saveWeeklySnapshot(
  userId: string,
  conversationId: string,
  conversationTitle?: string | null,
): Promise<ProgressEntry | null> {
  const result = await saveWeeklyDynamics(userId, conversationId, conversationTitle);
  return result.ok ? result.entry : null;
}
