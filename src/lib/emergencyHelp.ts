/**
 * «Срочная помощь»: the approved crisis contacts as a fixed text that the app shows when a person presses the exclamation mark
 * in the top row of the chat. No model, no words: the text is always the same.
 * It says the same as the paragraph of the prompt (supabase/functions/_shared/promptCore): the numbers are kept equal by
 * supabase/functions/_shared/promptCore/k3Prompt.cases.test.ts.
 */

export type EmergencyHelpPart = string | { label: string; href: string };

export const EMERGENCY_HELP_COPY = {
  button: 'Срочная помощь',
  title: 'Если сейчас очень тяжело',
  close: 'Закрыть',
  rows: [
    [
      'В России для психологической кризисной поддержки есть линия МЧС ',
      { label: '+7 (495) 989-50-50', href: 'tel:+74959895050' },
      '.',
    ],
    [
      'При непосредственной угрозе жизни или физической опасности нужны ',
      { label: '112', href: 'tel:112' },
      ' или ',
      { label: '103', href: 'tel:103' },
      '.',
    ],
    [
      'В другой стране нужна местная экстренная служба, а психологическую кризисную поддержку можно найти на ',
      { label: 'findahelpline.com', href: 'https://findahelpline.com' },
      '.',
    ],
    [
      'Для ребёнка, подростка или родителя, который обращается по поводу ребёнка, есть телефон ',
      { label: '8-800-2000-122', href: 'tel:88002000122' },
      '.',
    ],
  ] as EmergencyHelpPart[][],
} as const;

/** The plain text of one row (for the tests and for a screen reader). */
export function emergencyHelpRowText(row: readonly EmergencyHelpPart[]): string {
  return row.map((part) => (typeof part === 'string' ? part : part.label)).join('');
}
