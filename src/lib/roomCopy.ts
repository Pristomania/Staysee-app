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
    'Все беседы, записки и память исчезнут сразу и без восстановления. Запись для входа на сервере будет стёрта автоматически через 14 дней.',
  deleteRoomAction: 'Удалить комнату навсегда',
  deleteRoomPasswordPlaceholder: 'Пароль от комнаты',
  deleteRoomPasswordWrong: 'Неверный пароль. Удаление отменено.',
  deleteRoomSubmit: 'Удалить без восстановления',
  deleteRoomCancel: 'Отмена',
  deleteRoomDone: 'Комната удалена. Через 14 дней исчезнет и запись для входа.',
  roomDeletedLogin: 'Эта комната удалена. Восстановление невозможно.',
} as const;
