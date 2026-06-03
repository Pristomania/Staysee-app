# Маршрутизация моделей (OpenRouter)

Чат вызывает **один** API — OpenRouter (`OPENROUTER_API_KEY`).  
Модель на каждый ответ подбирается **на сервере** по глубине реплики (`brief` / `medium` / `deep`) и типу safety.

Frontend **не** знает про OpenRouter и **не** выбирает модель (кроме отладки через body — не для прод).

## Как это связано с «глубиной»

| Глубина | Когда | Модель по умолчанию |
|---------|--------|---------------------|
| **brief** | «привет», «спасибо», короткая реплика | `anthropic/claude-3.5-haiku` (дёшево) |
| **medium** | обычный диалог | `openai/gpt-4.1` |
| **deep** | длинный текст, эмоции, «разобраться» | `openai/gpt-4.1` |
| **crisis** | кризис (safety) | `openai/gpt-4.1` |

Код: `supabase/functions/_shared/responseBudget.ts` (глубина) + `modelRouter.ts` (модель).

## Секреты Supabase (Edge Functions)

Dashboard → Project → **Edge Functions** → **Secrets**:

| Secret | Назначение |
|--------|------------|
| `OPENROUTER_API_KEY` | обязательно |
| `STAYSEE_CHAT_MODEL_BRIEF` | переопределить brief |
| `STAYSEE_CHAT_MODEL_MEDIUM` | переопределить medium |
| `STAYSEE_CHAT_MODEL_DEEP` | переопределить deep |
| `STAYSEE_CHAT_MODEL_CRISIS` | кризис |
| `STAYSEE_CHAT_MODEL` | legacy: если depth-ключи не заданы, подставляется везде |

Примеры OpenRouter id (проверьте на https://openrouter.ai/models):

```text
STAYSEE_CHAT_MODEL_BRIEF=anthropic/claude-3.5-haiku
STAYSEE_CHAT_MODEL_MEDIUM=openai/gpt-4.1
STAYSEE_CHAT_MODEL_DEEP=openai/gpt-4.1
# альтернатива для deep:
# STAYSEE_CHAT_MODEL_DEEP=anthropic/claude-sonnet-4-5
# STAYSEE_CHAT_MODEL_MEDIUM=google/gemini-2.5-flash
```

После смены секретов:

```bash
npx supabase functions deploy staysee-chat --project-ref jnxrildlwvtxhtiwucbt
```

## Логи

В логах функции:

```text
[staysee-chat] depth=medium model=openai/gpt-4.1 route=medium maxTokens=900
```

`route=` — откуда взята модель (`brief` | `medium` | `deep` | `crisis` | `request`).

## Аналитика

Таблица `ai_usage_logs`, поле `model` — фактическая модель OpenRouter на запрос.  
`npm run usage:report` — сводка по моделям и USD.

## Другие провайдеры (не OpenRouter)

В коде есть заготовки `openai`, `gemini`, `mistral` с отдельными API-ключами — fallback, если OpenRouter недоступен.  
Основной путь для StaySee — **только OpenRouter**, чтобы менять модели одной настройкой.

## Будущее: стиль клиента

Сейчас маршрутизация **только по глубине + safety**.  
Позже можно добавить в `profiles` поле `preferred_chat_model` или `model_preset` без смены UI — один раз в `modelRouter.ts`.

## Стоимость

- **brief** на Haiku — сильно дешевле коротких реплик.
- **medium/deep** на GPT 4.1 — обычно дешевле Sonnet 4.5 при сопоставимом тоне StaySee.
- Sonnet имеет смысл оставить только для экспериментов: `STAYSEE_CHAT_MODEL_DEEP=anthropic/claude-sonnet-4-5`.

---

## Пресет для вашего проекта (по логам 7 дней)

Факт из `ai_usage_logs` (211 вызовов API, ~$4.82):

| Метрика | Значение |
|---------|----------|
| Модель сейчас | **203×** `claude-sonnet-4-5`, 8× haiku |
| **~$0,023** на один вызов API | совпадает с вашими **435 сообщ ≈ $10** |
| Вход (prompt) | **~6000** токенов в среднем — главная статья расхода |
| Выход (ответ) | **~380** токенов |
| Контекст (summary+архив) | **~2000** токенов в промпте на запрос |

**Вывод:** дорого не «модель вообще», а **Sonnet на каждый ход** + толстый промпт (память/архив).

### Скопировать в Supabase → Edge Functions → Secrets

```text
STAYSEE_CHAT_MODEL_BRIEF=anthropic/claude-3.5-haiku
STAYSEE_CHAT_MODEL_MEDIUM=openai/gpt-4.1
STAYSEE_CHAT_MODEL_DEEP=openai/gpt-4.1
STAYSEE_CHAT_MODEL_CRISIS=openai/gpt-4.1
```

**Удалите или не задавайте** `STAYSEE_CHAT_MODEL=anthropic/claude-sonnet-4-5` — иначе он перебивает пресет по глубине.

Затем:

```bash
npx supabase functions deploy staysee-chat --project-ref jnxrildlwvtxhtiwucbt
```

### Ожидаемый эффект (оценка)

| Сценарий | ~$ за 1 вызов API | ~435 сообщений |
|----------|-------------------|----------------|
| Сейчас (все Sonnet) | $0,023 | **~$10** |
| Пресет выше (40% brief / 60% medium+deep) | **$0,010–0,012** | **~$4,5–5** |
| + короче ответы (меньше «отзеркаливания») | ещё −10–15% | **~$4** |

Проверка через неделю:

```bash
npm run usage:report
node scripts/usage-breakdown-7d.mjs
```

### Если GPT 4.1 на deep не понравится

Только deep переключить на Sonnet, остальное оставить:

```text
STAYSEE_CHAT_MODEL_DEEP=anthropic/claude-sonnet-4-5
```

### Экономия без смены модели

Сделано: см. **`docs/COST_OPTIMIZATION.md`** (архив по режимам, промпты, auto-continue 5).
