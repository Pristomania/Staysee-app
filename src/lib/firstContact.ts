/**
 * The introduction that opens the very first conversation of an account: who Stacy is, and the offer to get acquainted
 * (the name and the way to address the person) or to stay incognito. It is saved as the first message of the conversation, so it
 * is shown like any message and goes to the model as history with the first answer (the text of the prompt says what to do with
 * the reply: keep the name and the gender if given, nothing if the person stays incognito).
 * The text is approved by the founder (19.11.2026).
 */

export const FIRST_CONTACT_MESSAGE =
  'Привет. Я Стэйси. Я рядом, когда хочется выговориться, разобраться в себе или просто побыть с тем, что внутри. ' +
  'Здесь можно не торопиться: я слушаю, замечаю и помогаю услышать себя.\n\n' +
  'Хочешь познакомиться: скажи, как тебя зовут и как к тебе обращаться? Или предпочитаешь остаться инкогнито?';

/** The introduction belongs to the first conversation only: the person has no conversation yet. */
export function isFirstConversation(existingConversationCount: number): boolean {
  return existingConversationCount === 0;
}
