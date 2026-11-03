import { formatDateRu } from './dateRu';

/** User-facing «комната» = личное пространство StaySee (не «аккаунт»). */
export const ROOM_COPY = {
  age18Confirm: 'Подтверждаю, что мне исполнилось 18 лет',
  age18Required: 'Нужно подтвердить возраст 18+',
  createRoom: 'Создать комнату',
  alreadyHaveRoom: 'У меня уже есть комната',
  leaveRoom: 'Выйти из комнаты',
  // Also true for a room deleted in the last 3 months: its sign-in record is kept that long (migration 093), then the
  // daily clean-up erases it. The exact day is shown after signing in (it is not given to whoever only types an address).
  roomExistsEmail:
    'С этим email уже связана комната: действующая или удалённая меньше 3 месяцев назад. Действующую можно открыть через вход или «Забыли пароль?». Новую комнату на адрес удалённой можно создать через 3 месяца после удаления: точную дату покажет вход.',
  resetEmailHint: 'Если комната с этим email есть — на почту придёт письмо StaySee AI со ссылкой для нового пароля.',
  contextTitle: 'Контекст',
  contextSubtitle: 'Оформление, память и ваше пространство',
  deleteRoomHint:
    'Беседы, записки и память исчезнут сразу и без восстановления, вы выйдете из комнаты. Запись для входа (адрес почты и пароль) хранится ещё 3 месяца, чтобы бесплатные сообщения нельзя было получить заново повторной регистрацией, затем стирается сама. Новую комнату на этот адрес можно будет создать после этого срока.',
  deleteRoomAction: 'Удалить комнату навсегда',
  // The free plan only: the memory is not shown there, so it can still be wiped unseen, apart from the account.
  deleteDataTitle: 'Удалить данные аккаунта',
  deleteDataHint:
    'Беседы, записки и вся память, в том числе та, которую вы не видите на бесплатном тарифе, исчезнут навсегда. Сам аккаунт, тариф и счётчик сообщений останутся.',
  deleteDataButton: 'Удалить данные',
  deleteDataDone: 'Данные удалены. Аккаунт остался, можно начать новую беседу.',
  // What the person is told when they press the button, before the final "yes": what goes and what stays.
  deleteDataConfirmGoes: [
    'Все беседы и сообщения в них',
    'Все записки и недельные снимки',
    'Вся память: сквозная (между беседами), память внутри бесед и сохранённые поправки',
  ],
  deleteDataConfirmStays:
    'Останутся ваш аккаунт и вход, тариф, остаток сообщений и докупленные сообщения: они никуда не пропадут. Удалённое восстановить нельзя.',
  deleteMemoryHint: 'Всю накопленную память, между беседами и внутри каждой, можно удалить в любой момент. Сами беседы останутся.',
  deleteMemoryButton: 'Удалить всю память',
  deleteMemoryDone: 'Вся память удалена.',
  deleteMemoryConfirmGoes: [
    'Сквозная память (между беседами)',
    'Память внутри бесед',
    'Сохранённые поправки',
  ],
  deleteMemoryConfirmStays:
    'Беседы, записки, тариф, остаток сообщений и докупленные сообщения останутся. Удалённое восстановить нельзя.',
  deleteRoomPasswordPlaceholder: 'Пароль от комнаты',
  deleteRoomPasswordWrong: 'Неверный пароль. Удаление отменено.',
  deleteRoomSubmit: 'Удалить без восстановления',
  deleteRoomCancel: 'Отмена',
  deleteRoomDone: 'Комната удалена. Новую на этот адрес можно будет создать через 3 месяца.',
  roomDeletedLogin:
    'Эта комната удалена, восстановить её нельзя. Новую комнату на этот email можно будет создать через 3 месяца после удаления.',
} as const;

/**
 * What the person is told when they sign in to a deleted room. With the day the database holds (the day the sign-in
 * record is erased) it is the exact day; without it, or with a broken one, the plain words.
 */
export function roomDeletedLoginText(availableFrom: string | null | undefined, now: Date = new Date()): string {
  const date = availableFrom ? new Date(availableFrom) : null;
  if (!date || Number.isNaN(date.getTime())) return ROOM_COPY.roomDeletedLogin;
  return `Эта комната удалена, восстановить её нельзя. Новую комнату на этот email можно будет создать с ${formatDateRu(date, now)}.`;
}
