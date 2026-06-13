import { supabase } from './supabase';
import { dedupeMemoryItems, normalizeDedupKey } from './memoryDisplay';
import { filterTensionNotes, type ProgressEntry } from './progressDiary';
import { parseConversationMemory, type StructuredMemory } from './memoryUi';
import type { UserMemory } from '../types';

export interface MessageActivityWindow {
  recentCount: number;
  previousCount: number;
}

export interface DynamicsChangingView {
  newItems: string[];
  fadedItems: string[];
  repeatedItems: string[];
  activityText: string | null;
  empty: boolean;
}

export interface DynamicsRepeatingItem {
  text: string;
  sublabel: string;
  displayText: string;
}

const REPEATING_THEME_PHRASES: Record<string, string> = {
  предательство: 'переживание предательства',
  сепарация: 'сепарация с близкими',
  здоровье: 'здоровье и тело',
  страх: 'страхи и тревога',
  'семейные отношения': 'семейные отношения',
  истощение: 'чувство истощения',
  'потеря контроля': 'страх потери контроля',
};

/** Display-only phrasing — source data unchanged. */
export function humanizeRepeatingTheme(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const key = t.toLowerCase().replace(/\s+/g, ' ');
  if (REPEATING_THEME_PHRASES[key]) return REPEATING_THEME_PHRASES[key];
  if (key === 'сепарация сына' || (key.includes('сепарац') && key.includes('сын'))) {
    return 'сепарация сына';
  }
  if (t.length > 40) return t;
  if (/^[а-яё\s-]+$/i.test(t) && t === t.toLowerCase()) {
    return t.charAt(0).toLowerCase() + t.slice(1);
  }
  return t;
}

export interface DynamicsAliveItem {
  text: string;
  source: 'open_loops' | 'tension' | 'weekly';
}

export interface ConversationDynamicsData {
  memory: StructuredMemory;
  weeklies: ProgressEntry[];
  tensions: ProgressEntry[];
  crossMemory: UserMemory[];
  messageActivity: MessageActivityWindow;
}

function isSimilarText(a: string, b: string): boolean {
  const ka = normalizeDedupKey(a);
  const kb = normalizeDedupKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.length >= 12 && kb.length >= 12 && (ka.includes(kb) || kb.includes(ka))) return true;
  return false;
}

function dedupeTexts(texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    const t = text.trim();
    if (!t) continue;
    if (out.some((x) => isSimilarText(x, t))) continue;
    out.push(t);
  }
  return out;
}

function splitWeeklyPhrases(text: string): string[] {
  return text
    .split(/[\n.;]+/)
    .map((p) => p.replace(/^[\s\-–—]+/, '').trim())
    .filter((p) => p.length >= 8);
}

function compareWeeklies(newer: string, older: string) {
  const newerPhrases = splitWeeklyPhrases(newer);
  const olderPhrases = splitWeeklyPhrases(older);
  const newItems: string[] = [];
  const fadedItems: string[] = [];
  const repeatedItems: string[] = [];

  for (const phrase of newerPhrases) {
    const inOlder = olderPhrases.some((o) => isSimilarText(phrase, o));
    if (inOlder) repeatedItems.push(phrase);
    else newItems.push(phrase);
  }
  for (const phrase of olderPhrases) {
    const inNewer = newerPhrases.some((n) => isSimilarText(phrase, n));
    if (!inNewer) fadedItems.push(phrase);
  }

  return {
    newItems: dedupeTexts(newItems).slice(0, 4),
    fadedItems: dedupeTexts(fadedItems).slice(0, 4),
    repeatedItems: dedupeTexts(repeatedItems).slice(0, 3),
  };
}

function messageWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'сообщение';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'сообщения';
  return 'сообщений';
}

function buildActivityText(activity: MessageActivityWindow): string | null {
  const { recentCount, previousCount } = activity;
  if (recentCount === 0 && previousCount === 0) return null;
  if (recentCount === 0 && previousCount > 0) {
    return 'За последнюю неделю в этой беседе было тише, чем на прошлой.';
  }
  if (recentCount > 0 && previousCount === 0) {
    return `За последнюю неделю вы написали ${recentCount} ${messageWord(recentCount)} — раньше здесь было тише.`;
  }
  if (recentCount > previousCount) {
    return `За последнюю неделю вы написали ${recentCount} ${messageWord(recentCount)} — чаще, чем на прошлой неделе (${previousCount}).`;
  }
  if (recentCount < previousCount) {
    return `За последнюю неделю вы написали ${recentCount} ${messageWord(recentCount)} — реже, чем на прошлой неделе (${previousCount}).`;
  }
  return `За последние две недели ритм примерно одинаковый — около ${recentCount} ${messageWord(recentCount)} в неделю.`;
}

function themesInMultipleWeeklies(themes: string[], weeklies: ProgressEntry[]): string[] {
  if (weeklies.length < 2 || themes.length === 0) return [];
  const texts = weeklies.map((w) => w.content);
  return themes.filter((theme) => {
    const hits = texts.filter(
      (t) => isSimilarText(theme, t) || normalizeDedupKey(t).includes(normalizeDedupKey(theme)),
    );
    return hits.length >= 2;
  });
}

function extractUnfinishedFromWeekly(text: string): string[] {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/(?:остаётся живым|остается живым|незаверш|открыт[ао]?\s+линия)[:\s—-]+(.+)/i);
    if (m?.[1]) out.push(m[1].trim());
    else if (/остаётся|остается|незаверш/i.test(line) && line.length >= 12) out.push(line);
  }
  return dedupeTexts(out);
}

export function buildChangingView(data: ConversationDynamicsData): DynamicsChangingView {
  const latest = data.weeklies[0];
  const previous = data.weeklies[1];
  let newItems: string[] = [];
  let fadedItems: string[] = [];
  let repeatedItems: string[] = [];

  if (latest && previous) {
    const diff = compareWeeklies(latest.content, previous.content);
    newItems = diff.newItems;
    fadedItems = diff.fadedItems;
    repeatedItems = diff.repeatedItems;
  }

  const activityText = buildActivityText(data.messageActivity);
  const empty =
    newItems.length === 0 &&
    fadedItems.length === 0 &&
    repeatedItems.length === 0 &&
    !activityText;

  return { newItems, fadedItems, repeatedItems, activityText, empty };
}

export function buildRepeatingView(data: ConversationDynamicsData): DynamicsRepeatingItem[] {
  const themes = dedupeMemoryItems(
    data.memory.themes
      .map((text, index) => ({ fieldKey: 'themes' as const, index, text: text.trim() }))
      .filter((i) => i.text.length > 0),
  );
  const overlap = themesInMultipleWeeklies(
    themes.map((t) => t.text),
    data.weeklies,
  );
  const items: DynamicsRepeatingItem[] = [];

  for (const item of themes) {
    const inWeekly = overlap.some((t) => isSimilarText(t, item.text));
    items.push({
      text: item.text,
      sublabel: inWeekly ? 'returnsHere' : 'inFocus',
      displayText: humanizeRepeatingTheme(item.text),
    });
  }

  return items;
}

export function buildAliveView(data: ConversationDynamicsData): DynamicsAliveItem[] {
  const items: DynamicsAliveItem[] = [];

  for (const text of dedupeTexts(data.memory.open_loops)) {
    items.push({ text, source: 'open_loops' });
  }
  for (const entry of data.tensions) {
    const text = entry.content.trim();
    if (!text) continue;
    if (items.some((i) => isSimilarText(i.text, text))) continue;
    items.push({ text, source: 'tension' });
  }
  const latestWeekly = data.weeklies[0];
  if (latestWeekly) {
    for (const text of extractUnfinishedFromWeekly(latestWeekly.content)) {
      if (items.some((i) => isSimilarText(i.text, text))) continue;
      items.push({ text, source: 'weekly' });
    }
  }

  return items;
}

export async function fetchConversationMemory(
  userId: string,
  conversationId: string,
): Promise<StructuredMemory | null> {
  const { data, error } = await supabase
    .from('conversations')
    .select('conversation_summary')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return parseConversationMemory((data?.conversation_summary as string | null) ?? null);
}

export async function fetchMessageActivityForConversation(
  conversationId: string,
): Promise<MessageActivityWindow> {
  const now = Date.now();
  const recentSince = new Date(now - 7 * 86_400_000).toISOString();
  const previousSince = new Date(now - 14 * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from('messages')
    .select('created_at, sender, content')
    .eq('conversation_id', conversationId)
    .eq('sender', 'user')
    .gte('created_at', previousSince);

  if (error) {
    console.error('[dynamics] messages:', error.message);
    return { recentCount: 0, previousCount: 0 };
  }

  let recentCount = 0;
  let previousCount = 0;
  const recentMs = Date.parse(recentSince);

  for (const m of data ?? []) {
    const text = (m.content ?? '').trim();
    if (text.length < 2) continue;
    if (Date.parse(m.created_at) >= recentMs) recentCount++;
    else previousCount++;
  }

  return { recentCount, previousCount };
}

export async function fetchCrossMemoryForUser(userId: string): Promise<UserMemory[]> {
  const { data, error } = await supabase
    .from('user_memory')
    .select('id, user_id, memory_type, content, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as UserMemory[];
}

export async function fetchTensionsForConversation(
  userId: string,
  conversationId: string,
): Promise<ProgressEntry[]> {
  const { data, error } = await supabase
    .from('progress_entries')
    .select('id, user_id, entry_date, entry_type, content, conversation_id, created_at')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .eq('entry_type', 'tension')
    .order('created_at', { ascending: false })
    .limit(40);
  if (error) {
    console.error('[dynamics] tensions:', error.message);
    return [];
  }
  return filterTensionNotes((data ?? []) as ProgressEntry[]);
}
