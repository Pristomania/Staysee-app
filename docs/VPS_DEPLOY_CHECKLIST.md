# StaySee — пошаговый деплой на VPS (для вас)

**Ваш Supabase project ref:** `jnxrildlwvtxhtiwucbt`  
**Ссылка на проект в Supabase:** https://supabase.com/dashboard/project/jnxrildlwvtxhtiwucbt  

**Ваш домен сайта:** `staysee.ru` (далее **МОЙ-ДОМЕН**).

**Частая ошибка без VPN:** сборка без `.env.production` → в `dist` зашит `*.supabase.co` из `.env`.  
Обязательно: `VITE_SUPABASE_URL=https://staysee.ru/supabase` и `npm run build` (есть проверка бандла).

---

## Что понадобится заранее

- [ ] VPS (сервер) с Ubuntu, доступ по SSH (логин/пароль или ключ — обычно присылает хостинг)
- [ ] Домен **МОЙ-ДОМЕН** привязан к IP этого VPS (запись A в DNS у регистратора домена)
- [ ] Папка проекта на компьютере: `Staisy-main`
- [ ] Node.js 20+ на компьютере **или** на VPS (если собирать сайт на сервере)
- [ ] 30–60 минут

**Важно про секреты:** файл `.env` на компьютере содержит ключи. Его **нельзя** выкладывать на сайт и нельзя класть в папку `dist`. На VPS для сайта нужны только 2 строки для сборки (см. шаг 8).

---

## Часть 1. Supabase (в браузере, без программирования)

### Шаг 1. Открыть настройки адресов для входа

1. Откройте: https://supabase.com/dashboard/project/jnxrildlwvtxhtiwucbt/auth/url-configuration  
2. Поле **Site URL** — впишите:  
   `https://МОЙ-ДОМЕН`  
   (без слэша в конце)  
3. **Redirect URLs** — добавьте **каждую строку отдельно** (кнопка Add URL):

   ```
   https://МОЙ-ДОМЕН
   http://localhost:5173
   http://127.0.0.1:5173
   ```

4. Нажмите **Save**.

### Шаг 2. Письмо «Забыли пароль» на русском (StaySee)

1. Откройте: https://supabase.com/dashboard/project/jnxrildlwvtxhtiwucbt/auth/templates  
2. Шаблон **Reset password** (сброс пароля):  
   - **Subject:** `Сброс пароля — StaySee AI`  
   - **Body:** откройте на компьютере файл  
     `Staisy-main/supabase/templates/recovery.html`  
     скопируйте **весь** текст и вставьте в поле письма в Supabase.  
   - В тексте должна остаться строка `{{ .ConfirmationURL }}` — не удаляйте её.  
3. **Save**.

Если письмо снова «не StaySee» — шаблон не сохранён в Dashboard (файл в проекте сам по себе письма не меняет).

### Шаг 3. Секрет для AI (OpenRouter) — только на сервере Supabase

1. Откройте: https://supabase.com/dashboard/project/jnxrildlwvtxhtiwucbt/settings/functions  
2. Раздел **Secrets** (или Edge Functions → Secrets).  
3. Должен быть секрет **`OPENROUTER_API_KEY`** (значение — ваш ключ OpenRouter с сайта openrouter.ai).  
4. Если нет — **Add secret** → имя `OPENROUTER_API_KEY` → вставьте ключ → Save.

**Не добавляйте** `OPENROUTER_API_KEY` в настройки Vercel/VPS для сайта — только сюда.

### Шаг 4. Проверить, что функции AI уже на облаке Supabase

Это делается **один раз** с компьютера, где установлен Node (или попросите разработчика).

1. Откройте терминал в папке `Staisy-main`.  
2. Выполните по очереди (копируйте целиком):

```text
npx supabase login
npx supabase link --project-ref jnxrildlwvtxhtiwucbt
npx supabase functions deploy staysee-chat
npx supabase functions deploy weekly-reflection
npx supabase db push
```

3. В конце не должно быть красной ошибки.  
4. Проверка списка функций:

```text
npx supabase functions list
```

Должны быть **ACTIVE**: `staysee-chat`, `weekly-reflection`.

---

## Часть 2. Собрать сайт на компьютере

### Шаг 5. Файл настроек для сборки

1. В папке `Staisy-main` скопируйте файл:  
   `deploy/env.vps.build.example`  
   → переименуйте копию в: **`.env.production`**  
2. Откройте `.env.production` блокнотом и замените:

| Было | Стало |
|------|--------|
| `YOUR_DOMAIN` | ваш **МОЙ-ДОМЕН** (без https) |
| `your_anon_key_here` | ключ **anon public** из Supabase |

3. **Где взять anon key:**  
   https://supabase.com/dashboard/project/jnxrildlwvtxhtiwucbt/settings/api  
   → **Project API keys** → **anon** / **public** → Copy.

4. После правки файл должен выглядеть так (пример):

```env
VITE_SUPABASE_URL=https://МОЙ-ДОМЕН/supabase
VITE_SUPABASE_ANON_KEY=eyJ...или sb_publishable_...
```

5. Сохраните файл.

### Шаг 6. Сборка

В терминале в папке `Staisy-main`:

```text
npm install
npm run build
```

**Успех:** появилась папка **`dist`** с файлами `index.html` и папкой `assets`.

---

## Часть 3. VPS и Nginx (сервер)

Дальше — на VPS по SSH (PuTTY, Termius или «Терминал» на Mac).  
Команды вводите **на сервере**, если не написано иначе.

### Шаг 7. Установить Nginx (один раз на сервере)

```text
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /var/www/Staysee-app/dist
```

### Шаг 8. Загрузить собранный сайт на VPS

**Актуальный путь статики:** `/var/www/Staysee-app/dist` (тот же, что использует `deploy-staysee` при push в `main`).

**Вариант А — автоматически (рекомендуется):** push в ветку `main` → GitHub Actions вызывает `deploy-staysee`.

**Вариант Б — вручную через FileZilla / WinSCP**

1. Подключитесь к VPS по SFTP.  
2. Откройте `/var/www/Staysee-app/dist/`  
3. Загрузите **всё содержимое** локальной папки `dist` (`index.html` + `assets` в корне `dist`).

**Вариант В — scp с компьютера**

```text
scp -r dist/* USER@IP_ВАШЕГО_VPS:/var/www/Staysee-app/dist/
```

### Шаг 9. Настроить Nginx под ваш домен

**Не копируйте conf с захардкоженным `root`** — путь должен совпадать с шагом 8.

Для **staysee.ru** (уже настроен домен и cert):

```text
cd ~/Staysee-app
bash deploy/nginx/apply-on-vps.sh
```

Скрипт проверит каталог, `index.html`, `assets/`, подставит `root` и выведет в лог:

```text
Resolved nginx root:
/var/www/Staysee-app/dist

Source:
live-nginx-config
```

Для **нового домена:** отредактируйте `deploy/nginx/staysee.conf.example` (YOUR_DOMAIN / YOUR_PROJECT_REF), сохраните как `staysee.ru.conf` или свой conf, затем тот же `apply-on-vps.sh`.

Сообщение `syntax is ok` / `test is successful` — хорошо.

### Шаг 10. HTTPS (замочек в браузере)

На VPS:

```text
sudo certbot --nginx -d МОЙ-ДОМЕН
```

Следуйте вопросам certbot (email, согласие).  
Если домен с `www`, добавьте: `-d www.МОЙ-ДОМЕН`

---

## Часть 4. Проверка (с телефона, без VPN)

Откройте в браузере: **`https://МОЙ-ДОМЕН`**

Отметьте галочками:

- [ ] Сайт открывается, не пустой белый экран  
- [ ] Регистрация или вход  
- [ ] Список бесед, открывается старая беседа  
- [ ] Новая беседа, отправили сообщение — пришёл ответ StaySee  
- [ ] Иконка «мозг» — Память открывается  
- [ ] Иконка «перо» — Записки себе открываются  
- [ ] В профиле виден тариф / сколько запросов осталось  
- [ ] «Забыли пароль» — письмо на русском, ссылка ведёт на **https://МОЙ-ДОМЕН**

### Если что-то не работает

| Проблема | Что сделать |
|----------|-------------|
| Белый экран | Пересобрать шаг 5–6: в `.env.production` URL должен быть `https://МОЙ-ДОМЕН/supabase` |
| Ошибка входа / redirect | Повторить шаг 1, домен в Redirect URLs точно как в браузере |
| AI не отвечает | Шаг 3–4: секрет OpenRouter и deploy `staysee-chat` |
| 502 на сайте | Шаг 9: `sudo nginx -t`, проверить что `dist` в `/var/www/Staysee-app/dist` |
| 500 / assets 404 | Неверный `root` в nginx — `bash deploy/nginx/apply-on-vps.sh`, сверить путь в логе |
| Письмо не StaySee | Шаг 2: шаблон в Dashboard |

---

## Краткая шпаргалка (ваши значения)

| Что | Значение |
|-----|----------|
| Supabase ref | `jnxrildlwvtxhtiwucbt` |
| Прямой URL Supabase (только для справки) | `https://jnxrildlwvtxhtiwucbt.supabase.co` |
| URL для **сайта** после деплоя | `https://МОЙ-ДОМЕН` |
| URL в `.env.production` | `https://МОЙ-ДОМЕН/supabase` |
| Репозиторий на VPS | `$HOME/Staysee-app` |
| Статика SPA (канон) | `/var/www/Staysee-app/dist` |
| Деплой prod | push `main` → `deploy-staysee` |
| Nginx | `bash deploy/nginx/apply-on-vps.sh` — root + gzip; смотреть `Source:` в логе |
| AI в браузере | только через `https://МОЙ-ДОМЕН/supabase/functions/v1/...` |

---

## Аналитика расходов (не в приложении для всех)

Полный отчёт по деньгам — скрипт на сервере с **service role** (не для сайта).  
Файл секретов только на VPS, например `/root/staysee.ops.env`, права доступа только у админа.  
Подробнее: `docs/ANALYTICS.md` и `scripts/usage-report.mjs`.

В приложении пользователь видит **лимит запросов** в профиле — это уже работает через Supabase.
