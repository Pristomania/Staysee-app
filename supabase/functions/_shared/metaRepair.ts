/**
 * User asks to fix garbled / broken wording of the last assistant reply (not therapy continuation).
 */

const META_REPAIR_PATTERNS: RegExp[] = [
  /напиши\s+нормально/i,
  /нормально\s+писать/i,
  /ты\s+можешь\s+нормально\s+писать/i,
  /можешь\s+нормально\s+писать/i,
  /исправь\s+текст/i,
  /перепиши\s+нормально/i,
  /перепиши\s+(?:это\s+)?нормально/i,
  /без\s+опечат/i,
  /без\s+ошибок/i,
  /исправь\s+(?:ответ|сообщение|реплику)/i,
  /почини\s+текст/i,
  /текст\s+битый/i,
  /слова\s+склеил/i,
  /склеил\w*\s+слова/i,
];

export function hasMetaRepairIntent(message: string): boolean {
  const msg = message.trim();
  if (!msg || msg.length > 200) return false;
  return META_REPAIR_PATTERNS.some((p) => p.test(msg));
}
