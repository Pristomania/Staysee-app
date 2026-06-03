/**
 * Client-side capture intents: dialog memory vs self-notes nudge.
 *
 * Память беседы: «запомни …», «помни что …», «можешь (это) запомнить?»
 * Записки: записать / выписать / в записки — не путать с «запомнить» для AI.
 *
 * No \b — fails on Cyrillic in JavaScript.
 */

export type NotesCaptureSource = 'user' | 'ai';

export interface DialogMemoryCapture {
  action: 'dialog_memory';
  payload: string;
}

export interface NotesCapture {
  action: 'notes';
  payload: string;
}

export type UserCaptureIntent = DialogMemoryCapture | NotesCapture;

export interface ChatMessageContext {
  sender: string;
  content: string;
}

/** «запомни» as a word, not «запомнить». */
const REMEMBER_IMPERATIVE_RE = /(?:^|[\s,.!?;:—–-])запомни(?:\s|[,.!?;:—–-]|$)/i;
const REMEMBER_IMPERATIVE_ALT_RE = /помни\s+что/i;

/** Просьба к StaySee запомнить (не записки). */
const REMEMBER_REQUEST_RE =
  /(?:можешь|могла\s+бы|не\s+забудь|запомнишь|сможешь\s+запомнить|хочу\s+.*запомн)/i;

const NOTES_USER_PHRASES = [
  'надо записать',
  'нужно записать',
  'надо это записать',
  'нужно это записать',
  'хочу записать',
  'стоит записать',
  'запиши',
  'выписать',
  'сохранить мысль',
  'сохранить мысли',
  'сохранить это',
  'вернуться к этому',
  'не забыть',
  'в записки',
  'оставь записку',
  'можешь записать',
  'записать мысли',
] as const;

const NOTES_AI_PHRASES = [
  'можешь записать',
  'стоит записать',
  'запиши',
  'выписать',
  'в записки',
  'записки себе',
  'записать мысль',
  'записать мысли',
  'записать в записки',
  'если хочешь — запиши',
  'если хочешь - запиши',
] as const;

const WEAK_MEMORY_REFERENTS = new Set([
  'это',
  'то',
  'вот это',
  'всё это',
  'такое',
]);

export const CAPTURE_NUDGE_COPY = {
  notesTitle: 'Выписать в записки?',
  notesHint: 'Только эта беседа — для себя',
  notesAction: 'Записать',
  memorySaved: 'Сохранила в память беседы',
  memoryOpen: 'Открыть',
  dismissAria: 'Закрыть',
} as const;

function containsPhrase(text: string, phrases: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((p) => lower.includes(p));
}

export function isWeakMemoryPayload(payload: string): boolean {
  const p = payload.trim().toLowerCase().replace(/[.!?…]+$/g, '');
  if (!p || p.length < 4) return true;
  return WEAK_MEMORY_REFERENTS.has(p);
}

export function isRememberRequestToAi(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/запис|записк|выпис/i.test(t)) return false;
  if (!REMEMBER_REQUEST_RE.test(t)) return false;
  if (!/запомн/i.test(t) && !/не\s+забудь/.test(t)) return false;
  return true;
}

export function isExplicitRememberCommand(text: string): boolean {
  return REMEMBER_IMPERATIVE_RE.test(text) || REMEMBER_IMPERATIVE_ALT_RE.test(text);
}

/** Записки — только про запись; не «можешь запомнить». */
export function isNotesIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!containsPhrase(t, NOTES_USER_PHRASES)) return false;
  if (/запомн/i.test(t) && !/запис|выпис|записк/i.test(t)) return false;
  return true;
}

export function extractRememberPayload(text: string): string {
  const t = text.trim();

  const imperative = t.match(
    /(?:запомни|помни\s+что)\s*(?:[,:—–-]\s*)?(.+)/i,
  );
  if (imperative?.[1]?.trim()) return imperative[1].trim().slice(0, 420);

  const requestTail = t.match(
    /(?:запомни(?:шь)?|запомнить|запомни)\s+(?:про\s+)?(.+?)(?:\?|$)/i,
  );
  if (requestTail?.[1]?.trim() && !isWeakMemoryPayload(requestTail[1])) {
    return requestTail[1].trim().slice(0, 420);
  }

  const cleaned = t
    .replace(
      /^(?:ты\s+)?(?:можешь|могла\s+бы|не\s+забудь|запомнишь|сможешь)\s*(?:ли\s+)?(?:это\s+)?(?:запомнить|запомни)\s*[?]?\s*/i,
      '',
    )
    .replace(/(?:^|[\s,.!?;:—–-])запомни\s*/i, '')
    .replace(/^помни\s+что\s*/i, '')
    .trim();

  return cleaned.slice(0, 420);
}

/**
 * «Можешь это запомнить?» — в память идёт смысл из последнего ответа AI или реплики пользователя.
 */
export function resolveMemoryPayloadFromChat(
  requestMessage: string,
  messages: ChatMessageContext[],
): string {
  const direct = extractRememberPayload(requestMessage);
  if (!isWeakMemoryPayload(direct)) return direct;

  const req = requestMessage.trim();
  const prior = messages.filter((m) => m.content?.trim() && m.content.trim() !== req);

  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i];
    if (m.sender === 'ai' && m.content.trim().length >= 12) {
      return m.content.trim().slice(0, 420);
    }
  }

  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i];
    if (m.sender === 'user' && m.content.trim().length >= 12) {
      return m.content.trim().slice(0, 420);
    }
  }

  return req.slice(0, 420);
}

export function extractNotesPayload(text: string): string {
  const t = text.trim();

  const inline = t.match(
    /(?:надо|нужно|хочу|стоит)\s+(?:это\s+)?записать\s+(.+)/i,
  );
  if (inline?.[1]?.trim()) return inline[1].trim().slice(0, 1200);

  const imperative = t.match(
    /(?:запиши|записать|выписать|сохрани)(?:\s+(?:это|мысль|мысли))?\s*[,:—–-]?\s*(.+)/i,
  );
  if (imperative?.[1]?.trim() && imperative[1].trim().length > 8) {
    return imperative[1].trim().slice(0, 1200);
  }

  const stripped = t
    .replace(
      /^(?:я\s+)?(?:хочу|нужно|надо|стоит)\s+(?:это\s+)?(?:записать|выписать|сохранить)\s*/i,
      '',
    )
    .replace(/^(?:запиши|записать|выписать|сохрани)\s*(?:это|мысль|мысли)?\s*/i, '')
    .trim();

  return stripped || t;
}

export function detectUserCaptureIntent(text: string): UserCaptureIntent | null {
  const t = text.trim();
  if (!t) return null;

  if (isExplicitRememberCommand(t)) {
    return { action: 'dialog_memory', payload: extractRememberPayload(t) };
  }

  if (isNotesIntent(t)) {
    return { action: 'notes', payload: extractNotesPayload(t) };
  }

  if (isRememberRequestToAi(t)) {
    return { action: 'dialog_memory', payload: extractRememberPayload(t) };
  }

  return null;
}

export function detectAiNotesNudge(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/запомн/i.test(t) && !/запис|выпис|записк/i.test(t)) return false;
  return containsPhrase(t, NOTES_AI_PHRASES);
}

/** Short draft for notes sheet (cap length). */
export function notesDraftFromContext(
  userMessage: string,
  aiMessage?: string,
): string {
  const fromUser = extractNotesPayload(userMessage).trim();
  if (fromUser.length >= 12) return fromUser.slice(0, 1200);
  if (aiMessage) {
    const sentence = aiMessage
      .split(/(?<=[.!?])\s+/)
      .find((s) => detectAiNotesNudge(s));
    if (sentence) return sentence.trim().slice(0, 1200);
  }
  return userMessage.trim().slice(0, 1200);
}

export function nudgeDedupeKey(kind: string, snippet: string): string {
  return `${kind}:${snippet.trim().slice(0, 80).toLowerCase()}`;
}
