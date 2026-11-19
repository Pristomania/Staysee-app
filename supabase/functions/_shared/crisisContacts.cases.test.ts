/**
 * The crisis contacts are added by the code, not left to the model: the full approved list, only when it is needed,
 * and any other phone number the model writes in such a reply is removed.
 * Run: ./node_modules/.bin/tsx supabase/functions/_shared/crisisContacts.cases.test.ts
 */

import {
  CRISIS_CONTACTS_BLOCK,
  applyCrisisContacts,
  hasContactsBlock,
  shouldAppendCrisisContacts,
  stripUnapprovedPhones,
  type ContactsHistoryMessage,
} from "./crisisContacts.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── the block says everything the approved paragraph of the live prompt says ──────────────────────────
for (const part of ["+7 (495) 989-50-50", "112", "103", "findahelpline.com", "8-800-2000-122"]) {
  assert(CRISIS_CONTACTS_BLOCK.includes(part), `the block contains ${part}`);
}
assert(/ребёнка, подростка/.test(CRISIS_CONTACTS_BLOCK), "the children's line is named for a child, a teenager or a parent");
assert(/другой стране/.test(CRISIS_CONTACTS_BLOCK), "the block says what to do in another country");
assert(hasContactsBlock(`Привет.\n\n${CRISIS_CONTACTS_BLOCK}`), "a reply that carries the block is recognised");
assert(!hasContactsBlock("Позвони 112."), "a reply with only one number is not the block");

// ── another phone number from the model's memory is removed, the approved ones stay ────────────────────
{
  const reply = "Я слышу тебя. В Казахстане можно позвонить на линию 150 или на +7 (777) 123-45-67. При угрозе жизни: 112. Что сейчас происходит?";
  const { text, removed } = stripUnapprovedPhones(reply);
  assert(removed === 2, `two invented numbers removed, got ${removed}`);
  assert(!/150|777|123-45-67/.test(text), "the invented numbers are gone");
  assert(text.includes("112"), "the approved emergency number stays");
  assert(text.includes("Что сейчас происходит?"), "the rest of the reply stays");
}
{
  const reply = "Линия МЧС +7 (495) 989-50-50, а для подростка 8 (800) 2000-122. Позвони 103.";
  const { text, removed } = stripUnapprovedPhones(reply);
  assert(removed === 0 && text === reply, "approved numbers are never touched, in any common spelling");
}
{
  const reply = "Давай через 10 минут. В 2026 году мне 25 лет, у меня 3 вопроса. Сегодня 17 ноября.";
  assert(stripUnapprovedPhones(reply).removed === 0, "ordinary numbers (minutes, years, dates) are not phone numbers");
}

// ── when the contacts are added ─────────────────────────────────────────────────────────────────────────
const user = (content: string): ContactsHistoryMessage => ({ role: "user", content });
const assistant = (content: string): ContactsHistoryMessage => ({ role: "assistant", content });
const block = (): ContactsHistoryMessage => assistant(`Я рядом.\n\n${CRISIS_CONTACTS_BLOCK}`);

function decide(userMessage: string, history: ContactsHistoryMessage[], extra: { crisis?: boolean; signal?: boolean } = {}) {
  return shouldAppendCrisisContacts({ userMessage, categoryIsCrisis: extra.crisis ?? false, modelSignalCrisis: extra.signal ?? false, history });
}

assert(decide("Сегодня весь день беспокойство.", []).append === false, "no crisis: nothing added");
assert(decide("Я не хочу жить.", [], { crisis: true }).append === true, "the first crisis message: the block is added");
assert(decide("Мне очень плохо.", [], { signal: true }).append === true, "the model reports a crisis the words did not show: the block is added");
assert(decide("Что делать?", [user("Я не хочу жить."), block()], { crisis: true }).append === false, "the block was just given: not repeated on the next turn");
assert(decide("Дома есть таблетки. Я уже достала упаковку.", [user("Я не хочу жить."), block()], { crisis: true }).append === true, "the block is given again when the situation gets worse");
{
  const history = [user("Хочу исчезнуть."), block(), user("Не знаю."), assistant("Расскажи."), user("Ладно."), assistant("Хорошо.")];
  const d = decide("Ладно, всё, пока.", history);
  assert(d.append === true && /goodbye/.test(d.reason), "a goodbye after a crisis signal: the block is added even though the last message has no crisis words");
}
assert(decide("Ладно, всё, пока.", [user("Сегодня беспокойно."), assistant("Расскажешь?")]).append === false, "a goodbye with no crisis before it: nothing added");
{
  const history = [user("Хочу исчезнуть."), block(), user("а"), assistant("1"), user("б"), assistant("2"), user("в"), assistant("3"), user("г"), assistant("4"), user("д"), assistant("5")];
  assert(decide("Мне плохо.", history, { crisis: true }).append === true, "after several turns the contacts are given again");
}

// ── the reply that goes out ─────────────────────────────────────────────────────────────────────────────
{
  const out = applyCrisisContacts("Я слышу тебя. Позвони по линии 150. Ты сейчас в безопасности?", { userMessage: "Я не хочу жить.", categoryIsCrisis: true, modelSignalCrisis: false, history: [] });
  assert(out.appended && out.stripped === 1, "invented number removed, block added");
  assert(out.text.startsWith("Я слышу тебя."), "the model's words come first");
  assert(out.text.endsWith(CRISIS_CONTACTS_BLOCK), "the block comes last");
  assert(out.text.includes("Ты сейчас в безопасности?"), "the question stays in the model's part");
}
{
  const out = applyCrisisContacts("Просто разговор.", { userMessage: "Привет", categoryIsCrisis: false, modelSignalCrisis: false, history: [] });
  assert(!out.appended && out.text === "Просто разговор.", "no crisis: the reply is untouched");
}
{
  const already = `Я рядом.\n\n${CRISIS_CONTACTS_BLOCK}`;
  const out = applyCrisisContacts(already, { userMessage: "Я не хочу жить.", categoryIsCrisis: true, modelSignalCrisis: false, history: [] });
  assert(out.text === already && !out.appended, "a reply that already carries the block does not get a second one");
}
{
  // Outside a crisis the model's own words are not touched at all, whatever they contain.
  const out = applyCrisisContacts("Позвони подруге 8 (916) 123-45-67.", { userMessage: "Привет", categoryIsCrisis: false, modelSignalCrisis: false, history: [] });
  assert(out.text === "Позвони подруге 8 (916) 123-45-67." && out.stripped === 0, "outside a crisis no number is removed");
}

console.log("All crisisContacts cases passed.");
