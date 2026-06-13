/** Копирайт экрана «Динамика беседы». */
export const DYNAMICS_COPY = {
  title: 'Динамика',
  subtitle: 'Как меняется эта беседа от недели к неделе',
  intro:
    'Недельные снимки и изменения ритма — отдельно от памяти и ваших записок.',
  latestWeek: 'Последняя неделя',
  weekHistory: 'История недель',
  changing: 'Что изменилось',
  repeating: 'Что повторяется',
  repeatingIntro: 'Возвращаются темы:',
  alive: 'Что остаётся важным',
  aliveIntro: 'То, что ещё не завершилось',
  trendUp: 'Стало заметнее',
  trendDown: 'Стало менее заметно',
  trendRepeated: 'Повторяется',
  crossContext: 'Между беседами — как возможный контекст',
  emptyLatest: 'Пока нет недельной динамики. Создайте первый снимок.',
  emptyChanging: 'Пока мало данных для динамики.',
  emptyRepeating: 'Пока не видно, что возвращается.',
  emptyAlive: 'Пока нет открытых линий.',
  loading: 'Загружаю…',
  appeared: 'Появилось',
  faded: 'Стало менее заметно',
  repeated: 'Повторилось',
  rhythm: 'Ритм беседы',
  inFocus: 'Сейчас в фокусе',
  returnsHere: 'Возвращается в этой беседе',
  fromMemory: 'Из памяти беседы',
  fromNote: 'Из вашей записки',
  hubChat: 'Чат',
  hubMemory: 'Память',
  hubDynamics: 'Динамика',
  hubNotes: 'Записки',
} as const;

/** Show ↑/↓ trend grouping when at least two weekly snapshots exist. */
export const DYNAMICS_WEEKLY_TREND_MIN_WEEKLIES = 2;
