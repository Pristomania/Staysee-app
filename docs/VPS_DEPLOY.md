# Деплой StaySee на VPS (доступ из России без VPN)

## Архитектура (как сейчас в коде)

```
Браузер (РФ)
    │
    ├─► https://YOUR_DOMAIN/              → Nginx → dist/ (React SPA)
    │
    └─► https://YOUR_DOMAIN/supabase/...  → Nginx reverse proxy
              │
              └─► https://YOUR_PROJECT.supabase.co/
                      ├─ Auth / REST / Storage (anon key + JWT)
                      └─ Edge Functions
                              ├─ staysee-chat        → OpenRouter (сервер Supabase)
                              └─ weekly-reflection   → OpenRouter (сервер Supabase)
```

**Важно:** OpenRouter и `SUPABASE_SERVICE_ROLE_KEY` **не попадают в браузер**.  
Frontend знает только `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY`.

Прямых вызовов OpenRouter из `src/` нет — только `fetch(.../functions/v1/staysee-chat)` и `weekly-reflection`.

Для пользователя из РФ: сайт открывается на **вашем домене** (VPS в РФ или доступный без VPN). Запросы к Supabase идут **через тот же VPS** (`/supabase/`), а не напрямую на `*.supabase.co` из браузера.

---

## Чеклист готовности

| Пункт | Статус |
|--------|--------|
| `npm run build` | ✅ |
| OpenRouter во frontend | ✅ нет |
| Service role во frontend | ✅ нет |
| AI через Edge Functions | ✅ `staysee-chat`, `weekly-reflection` |
| Nginx SPA + proxy config | ✅ `deploy/nginx/staysee.conf.example` |
| Env для сборки | ✅ `deploy/env.vps.build.example` |

---

## 1. Переменные окружения

### На VPS — только для **сборки** frontend (или на CI)

| Переменная | Куда | Обязательно |
|------------|------|-------------|
| `VITE_SUPABASE_URL` | `https://YOUR_DOMAIN/supabase` | да |
| `VITE_SUPABASE_ANON_KEY` | anon public key | да |

Файл-шаблон: `deploy/env.vps.build.example` → скопировать в `.env.production` перед `npm run build`.

**Не задавать в Vite / не класть в `/var/www/staysee/dist`:**

| Переменная | Где должна быть |
|------------|-----------------|
| `OPENROUTER_API_KEY` | Supabase Dashboard → Edge Functions → **Secrets** |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Secrets + локальный `/root/staysee.ops.env` для скриптов |
| `BACKFILL_SECRET` | Edge / ops (по необходимости) |

### Supabase Edge Functions (Dashboard → Secrets)

Уже должны быть заданы для чата и аналитики:

- `OPENROUTER_API_KEY`
- `SUPABASE_URL` (часто подставляется автоматически)
- `SUPABASE_SERVICE_ROLE_KEY` (авто на hosted)

Проверка деплоя функций:

```bash
npx supabase functions list
```

Ожидаются **ACTIVE**: `staysee-chat`, `weekly-reflection` (+ ops: `backfill-conversation-summaries`, `consolidate-user-life-memory`).

---

## 2. Supabase Auth (обязательно)

Dashboard → **Authentication** → **URL Configuration**:

| Поле | Значение |
|------|----------|
| **Site URL** | `https://YOUR_DOMAIN` |
| **Redirect URLs** | `https://YOUR_DOMAIN`, `http://localhost:5173`, при необходимости preview |

Сброс пароля: `redirectTo: window.location.origin` — домен должен быть в списке.

Письма: шаблоны в Dashboard (см. [AUTH_EMAILS.md](./AUTH_EMAILS.md)) — файлы в `supabase/templates/` сами не отправляются.

---

## 3. Сборка frontend

На VPS или локально с production env:

```bash
cp deploy/env.vps.build.example .env.production
# отредактировать YOUR_DOMAIN и anon key

npm ci
npm run build
# артефакт: dist/
```

---

## 4. Nginx на VPS

### Требования

- Ubuntu 22.04+ / Debian 12+
- Nginx, Node 20+ (для сборки), certbot

### Установка статики

```bash
sudo mkdir -p /var/www/staysee
sudo rsync -av --delete dist/ /var/www/staysee/dist/
sudo chown -R www-data:www-data /var/www/staysee
```

### Конфиг

```bash
# В файле заменить YOUR_DOMAIN и YOUR_PROJECT_REF (из URL Supabase)
sudo cp deploy/nginx/staysee.conf.example /etc/nginx/sites-available/staysee
sudo ln -sf /etc/nginx/sites-available/staysee /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### HTTPS

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_DOMAIN
```

---

## 5. Порядок первого деплоя

```bash
# 1. Supabase: миграции, secrets, functions
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
npx supabase functions deploy staysee-chat
npx supabase functions deploy weekly-reflection

# 2. Auth URLs + email templates в Dashboard

# 3. VPS: nginx + build + rsync dist (см. выше)

# 4. Проверка прокси
curl -I https://YOUR_DOMAIN/supabase/rest/v1/
# ожидается ответ от Supabase (401/404 без ключа — нормально)
```

---

## 6. Ops-скрипты на VPS (аналитика / бэкфилл)

Не для браузера. Отдельный файл, права `600`:

```bash
# /root/staysee.ops.env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
OPENROUTER_API_KEY=...
```

```bash
cd /opt/staysee/repo
export $(grep -v '^#' /root/staysee.ops.env | xargs)
node scripts/usage-report.mjs
```

Отчёт расходов в UI: профиль → лимиты (`user_usage_tiers` через anon+RLS). Полный отчёт — ops-скрипт.

---

## 7. Проверка после деплоя (в т.ч. с телефона, без VPN)

- [ ] `https://YOUR_DOMAIN` открывается, нет «Missing Supabase environment variables»
- [ ] Вход / регистрация
- [ ] Сброс пароля (письмо + redirect на ваш домен)
- [ ] Список и открытие старых чатов
- [ ] Новая беседа, отправка сообщения, ответ AI
- [ ] Память (мозг)
- [ ] Записки себе (+ динамика недели)
- [ ] Профиль: тариф / остаток запросов (аналитика лимитов)

В DevTools → Network запросы к AI должны идти на  
`https://YOUR_DOMAIN/supabase/functions/v1/staysee-chat`, **не** на `openrouter.ai`.

---

## 8. Типичные проблемы

| Симптом | Решение |
|---------|---------|
| Белый экран / нет env | Пересобрать с `VITE_SUPABASE_URL=https://DOMAIN/supabase` |
| Auth redirect error | Добавить `https://YOUR_DOMAIN` в Redirect URLs |
| AI молчит / 502 на functions | Проверить Edge deploy + `OPENROUTER_API_KEY` в Secrets |
| CORS / 404 на /supabase | Проверить `proxy_pass` и `Host` в nginx |
| Письмо без бренда StaySee | Вставить HTML в Dashboard → Email Templates |

---

## 9. VPS vs Vercel

| | Vercel | VPS + Nginx |
|--|--------|-------------|
| Доступ из РФ без VPN | не гарантирован | да (свой домен + VPS) |
| Прокси Supabase | нет | да (`/supabase/`) |
| Сборка | `dist` | тот же `dist` |

См. также [VERCEL_DEPLOY.md](./VERCEL_DEPLOY.md) для preview/зарубежного хостинга.

---

## 10. Безопасность

- Не коммитить `.env`, `.env.production`, `staysee.ops.env`
- Не класть service role в `dist/` и не отдавать через Nginx
- Закрыть SSH, firewall (80/443), обновлять систему
- Опционально: basic auth на staging-домене
