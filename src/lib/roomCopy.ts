/** User-facing «комната» = личное пространство StaySee (не «аккаунт»). */
export const ROOM_COPY = {
  age18Confirm: 'Подтверждаю, что мне исполнилось 18 лет',
  age18Required: 'Нужно подтвердить возраст 18+',
  createRoom: 'Создать комнату',
  alreadyHaveRoom: 'У меня уже есть комната',
  leaveRoom: 'Выйти из комнаты',
  roomExistsEmail: 'Комната с этим email уже есть. Войдите или на экране входа — «Забыли пароль?».',
  resetEmailHint: 'Если комната с этим email есть — на почту придёт письмо StaySee AI со ссылкой для нового пароля.',
  contextTitle: 'Контекст',
  contextSubtitle: 'Оформление, память и ваше пространство',
  deleteRoomHint:
    'Удаляется всё, включая сам аккаунт: беседы, записки и память исчезнут сразу и без восстановления, вы выйдете, а запись для входа будет стёрта автоматически через 14 дней.',
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
  deleteRoomDone: 'Комната удалена. Через 14 дней исчезнет и запись для входа.',
  roomDeletedLogin: 'Эта комната удалена. Восстановление невозможно.',
} as const;
