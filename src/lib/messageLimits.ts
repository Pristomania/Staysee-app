// One message is at most 10,000 characters. The chat function enforces the same number
// (supabase/functions/_shared/longMessages.ts); a test keeps the two equal.
export const MAX_MESSAGE_CHARS = 10_000;

export interface MessageLengthState {
  length: number;
  max: number;
  tooLong: boolean;
  overBy: number;
}

/** Measures what will be sent: the text without leading and trailing blanks. */
export function messageLengthState(text: string): MessageLengthState {
  const length = text.trim().length;
  const overBy = Math.max(0, length - MAX_MESSAGE_CHARS);
  return { length, max: MAX_MESSAGE_CHARS, tooLong: overBy > 0, overBy };
}

// Groups digits with a non-breaking space: 10 340.
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
}

/**
 * The line shown under the input box. There is deliberately no counter: it distracts. A line appears only
 * for a text that is too long, because Send does not work then and the person needs to know why.
 */
export function messageLengthHint(state: MessageLengthState): string | null {
  if (!state.tooLong) return null;
  return `Слишком длинно: ${groupDigits(state.length)} из ${groupDigits(state.max)}. Раздели на части.`;
}
