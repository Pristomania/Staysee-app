# Деплой StaySee frontend на Vercel (закрытое тестирование)

Для доступа из **России без VPN** предпочтительнее [VPS_DEPLOY.md](./VPS_DEPLOY.md) (Nginx + прокси `/supabase/`).

Frontend — статический SPA (Vite + React). Бэкенд: Supabase (Auth, DB, Edge Functions).

## Статус проверки репозитория

| Проверка | Статус |
|----------|--------|
| `npm run build` | ✅ проходит (`dist/`) |
| `VITE_*` в коде | ✅ только `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| Service role во frontend | ✅ не используется |
| `vercel.json` (SPA rewrite) | ✅ добавлен |

## Vercel — настройки проекта

| Поле | Значение |
|------|----------|
| Framework Preset | Vite |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` |
| Root Directory | `.` (корень репо) |

### Environment Variables (Production + Preview)

Добавить **только** эти переменные (Environment: Production и при необходимости Preview):

| Variable | Пример | Где взять |
|----------|--------|-----------|
| `VITE_SUPABASE_URL` | `https://xxxx.supabase.co` | Supabase → Project Settings → API |
| `VITE_SUPABASE_ANON_KEY` | `eyJ...` (anon, public) | тот же экран, **anon** key |

**Не добавлять в Vercel:**

- `SUPABASE_SERVICE_ROLE_KEY` — только секреты Edge Functions / локальные скрипты
- любые ключи OpenRouter / провайдеров AI — они на стороне Supabase Functions

После добавления env — **Redeploy** (Vite вшивает `VITE_*` на этапе build).

## Закрытое тестирование (не публичный релиз)

1. **Не индексировать** — не публиковать ссылку в открытом доступе.
2. В Vercel: **Settings → Deployment Protection** → включить Password Protection или Vercel Authentication для Preview/Production (по плану).
3. Либо использовать неочевидный URL preview и раздавать ссылку только тестерам.

## Supabase Auth → URL Configuration

Dashboard → **Authentication** → **URL Configuration**:

1. **Site URL** — основной URL Vercel, например:
   - `https://staysee-test.vercel.app`
2. **Redirect URLs** — добавить все варианты, с которых открывается приложение:
   - `http://localhost:5173`
   - `http://127.0.0.1:5173`
   - `https://YOUR-PROJECT.vercel.app`
   - `https://YOUR-PROJECT-*.vercel.app` (если нужны preview-деплои; иначе добавлять каждый preview URL вручную)

Сброс пароля использует `redirectTo: window.location.origin` — домен Vercel должен быть в списке, иначе Auth вернёт ошибку redirect.

Подробнее: [AUTH_EMAILS.md](./AUTH_EMAILS.md)

## Edge Functions (Supabase, не Vercel)

Деплоятся отдельно из репозитория:

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase functions deploy staysee-chat
npx supabase functions deploy weekly-reflection
```

Опционально (ops / бэкфилл, не нужны для обычного UX в браузере):

```bash
npx supabase functions deploy backfill-conversation-summaries
npx supabase functions deploy consolidate-user-life-memory
```

Проверить список на проекте:

```bash
npx supabase functions list
```

Секреты функций (OpenRouter и т.д.) — **Supabase Dashboard → Edge Functions → Secrets**, не Vercel.

Убедиться, что применены миграции БД:

```bash
npx supabase db push
```

## Команды: первый деплой

```bash
# 1. Локально — убедиться что сборка ок
npm install
npm run build

# 2. Git push в GitHub/GitLab/Bitbucket

# 3. Vercel: Import Project → выбрать репо → env → Deploy

# 4. Supabase: redirect URLs + Site URL (см. выше)

# 5. Edge functions deploy (если ещё не на прод-проекте)
npx supabase functions deploy staysee-chat
npx supabase functions deploy weekly-reflection
```

CLI alternative:

```bash
npm i -g vercel
vercel login
vercel link
vercel env add VITE_SUPABASE_URL
vercel env add VITE_SUPABASE_ANON_KEY
vercel --prod
```

## Чеклист после деплоя (в т.ч. с телефона)

- [ ] Сайт открывается по HTTPS, нет белого экрана / ошибки env в консоли
- [ ] Регистрация / вход
- [ ] Сброс пароля (письмо → ссылка → экран нового пароля на **том же** Vercel-домене)
- [ ] Список бесед, открытие старого чата
- [ ] Новая беседа, отправка сообщения, ответ AI (`staysee-chat`)
- [ ] Память (иконка мозга)
- [ ] Записки себе (перо), запись, вкладки, динамика недели (`weekly-reflection`)
- [ ] Профиль / лимиты (если включены)

## Типичные проблемы

| Симптом | Решение |
|---------|---------|
| Белый экран, `Missing Supabase environment variables` | Env не заданы или деплой без rebuild после env |
| Auth redirect error | Добавить Vercel URL в Supabase Redirect URLs |
| AI не отвечает | Задеплоить `staysee-chat`, проверить secrets OpenRouter |
| Динамика недели не создаётся | `weekly-reflection` + миграции `progress_entries` |
| 404 при обновлении страницы | Проверить `vercel.json` rewrites |

## Project ref (пример из локального .env)

Замените на свой: URL вида `https://<project-ref>.supabase.co`.
