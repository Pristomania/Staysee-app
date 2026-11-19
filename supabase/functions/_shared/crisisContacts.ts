/**
 * The crisis contacts come from the code, not from the memory of the model.
 *
 * The model talks (and asks if the person is safe); the code adds the FULL approved list under the answer when it is needed,
 * and removes any other phone number the model wrote in such a reply (a model recalls hotlines of other countries wrongly).
 * The wording is the approved crisis paragraph of the live prompt (promptCore/legacyDocFlatPrompt.ts), word for word in meaning.
 */

import { isRegexCrisis } from "./safety.ts";

export type ContactsHistoryMessage = { role: "user" | "assistant"; content: string };

export const CRISIS_CONTACTS_BLOCK = [
  "Если сейчас очень тяжело, вот куда можно обратиться.",
  "В России для психологической кризисной поддержки есть линия МЧС +7 (495) 989-50-50.",
  "При непосредственной угрозе жизни или физической опасности нужны 112 или 103.",
  "В другой стране нужна местная экстренная служба, а психологическую кризисную поддержку можно найти на findahelpline.com.",
  "Для ребёнка, подростка или родителя, который обращается по поводу ребёнка, есть телефон 8-800-2000-122.",
].join("\n");

/** Digits of the long numbers the block names (in the two usual ways of writing the first digit), and the short ones. */
const APPROVED_LONG = new Set(["74959895050", "84959895050", "88002000122", "78002000122"]);
const APPROVED_SHORT = new Set(["112", "103"]);

const WINDOW = 12;
const REPEAT_AFTER_ASSISTANT_TURNS = 4;
const GOODBYE_RE = /(?:^|[\s,.!?«"(])(?:пока|до свидания|до связи|до завтра|прощай\w*|ухожу|ладно,?\s+всё|всё,?\s+пока|на сегодня (?:всё|хватит)|мне пора|пойду|спокойной ночи)(?=$|[\s,.!?»")])/iu;
const ESCALATION_RE = /(?:таблетк|упаковк|лезви|нож(?![а-я])|верёвк|петл[яюе]|выпью|выпила|выпил|порежу|повешусь|спрыгну|крыш[аеу]|балкон|прощайте|последн\w+ (?:раз|сообщение)|уже решил\w*|написал\w* записк)/iu;

// A phone number with any spacing: "+7 (495) 989-50-50", "8 (800) 2000-122", "8-800-2000-122".
const LONG_PHONE_RE = /(?:\+7|(?<!\d)8)(?:[\s\-().]*\d){10}(?!\d)/gu;
// A short number named as a hotline: "линию 150", "позвони по номеру 111", "телефон 124".
const SHORT_PHONE_RE = /(?:лини[июяе]\w*|телефон\w*|номер\w*|звон\w*|позвон\w*|набер\w*|набира\w*)\s+(?:[а-яёА-ЯЁA-Za-z«»"“”-]+\s+){0,3}?(\d{2,4})(?!\d)/giu;

export function hasContactsBlock(text: string): boolean {
  return /линия МЧС \+7 \(495\) 989-50-50/.test(text) && /findahelpline\.com/.test(text) && /8-800-2000-122/.test(text);
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/** Which phone numbers in this sentence are not on the approved list. */
function unapprovedIn(sentence: string): string[] {
  const found: string[] = [];
  for (const match of sentence.matchAll(LONG_PHONE_RE)) {
    if (!APPROVED_LONG.has(digitsOf(match[0]))) found.push(match[0]);
  }
  const withoutLong = sentence.replace(LONG_PHONE_RE, " ");
  for (const match of withoutLong.matchAll(SHORT_PHONE_RE)) {
    if (!APPROVED_SHORT.has(match[1])) found.push(match[1]);
  }
  return found;
}

/** A sentence that names a number that is not on the approved list is dropped whole; the rest of the reply stays as it was. */
export function stripUnapprovedPhones(text: string): { text: string; removed: number } {
  const sentences = text.split(/(?<=[.!?…])[ \t]+/u);
  let removed = 0;
  const kept: string[] = [];
  for (const sentence of sentences) {
    const bad = unapprovedIn(sentence);
    if (bad.length > 0) removed += bad.length;
    else kept.push(sentence);
  }
  return removed === 0 ? { text, removed: 0 } : { text: kept.join(" ").replace(/[ \t]{2,}/g, " ").trim(), removed };
}

export interface ContactsInput {
  userMessage: string;
  /** The words of this message match the crisis patterns (safety.category === "crisis"). */
  categoryIsCrisis: boolean;
  /** The model itself marked this turn as a crisis ([STAYSEE_SIGNAL: crisis_detected]). */
  modelSignalCrisis: boolean;
  history: ContactsHistoryMessage[];
}

function recent(history: ContactsHistoryMessage[]): ContactsHistoryMessage[] {
  return history.slice(-WINDOW);
}

/** A crisis in the last messages: the person's words, or the contacts were already given. */
function recentCrisis(history: ContactsHistoryMessage[]): boolean {
  return recent(history).some((m) => (m.role === "user" ? isRegexCrisis(m.content) : hasContactsBlock(m.content)));
}

export function shouldAppendCrisisContacts(input: ContactsInput): { append: boolean; reason: string } {
  const window = recent(input.history);
  const crisisNow = input.categoryIsCrisis || input.modelSignalCrisis;
  const goodbyeAfterCrisis = GOODBYE_RE.test(input.userMessage) && recentCrisis(window);
  if (!crisisNow && !goodbyeAfterCrisis) return { append: false, reason: "no_crisis" };

  const assistantReplies = window.filter((m) => m.role === "assistant");
  const lastThree = assistantReplies.slice(-3);
  if (!lastThree.some((m) => hasContactsBlock(m.content))) return { append: true, reason: goodbyeAfterCrisis && !crisisNow ? "goodbye_after_crisis" : "first_in_window" };

  if (ESCALATION_RE.test(input.userMessage)) return { append: true, reason: "escalation" };
  if (goodbyeAfterCrisis) return { append: true, reason: "goodbye_after_crisis" };

  let sinceBlock = 0;
  for (let i = assistantReplies.length - 1; i >= 0 && !hasContactsBlock(assistantReplies[i].content); i -= 1) sinceBlock += 1;
  if (sinceBlock >= REPEAT_AFTER_ASSISTANT_TURNS) return { append: true, reason: "periodic" };
  return { append: false, reason: "recently_given" };
}

export interface ContactsResult {
  text: string;
  appended: boolean;
  stripped: number;
  reason: string;
}

export function applyCrisisContacts(reply: string, input: ContactsInput): ContactsResult {
  const inCrisis = input.categoryIsCrisis || input.modelSignalCrisis || recentCrisis(input.history);
  let text = reply;
  let stripped = 0;
  if (inCrisis) {
    const cleaned = stripUnapprovedPhones(text);
    text = cleaned.text;
    stripped = cleaned.removed;
  }
  const decision = shouldAppendCrisisContacts(input);
  if (!decision.append || hasContactsBlock(text)) return { text, appended: false, stripped, reason: decision.append ? "already_present" : decision.reason };
  text = text.trim() === "" ? CRISIS_CONTACTS_BLOCK : `${text.trimEnd()}\n\n${CRISIS_CONTACTS_BLOCK}`;
  return { text, appended: true, stripped, reason: decision.reason };
}
