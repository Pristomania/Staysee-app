# OpenRouter — аналитика расходов StaySee

## Где хранится usage

**Таблица:** `public.ai_usage_logs` (Supabase)

| Поле | Описание |
|------|----------|
| `user_id` | Пользователь |
| `conversation_id` | Беседа (может быть `null` для фоновых задач) |
| `model` | ID модели OpenRouter |
| `prompt_tokens` | Токены запроса |
| `completion_tokens` | Токены ответа |
| `total_tokens` | Всего |
| `memory_tokens` | Оценка: сквозная `user_memory` в system prompt |
| `summary_tokens` | Оценка: `conversation_summary` + **архив этой беседы** (retrieval) в system prompt (или весь prompt при обновлении summary) |
| `cost` | USD: из `usage.cost` OpenRouter или расчёт по pricing |
| `created_at` | Время запроса |

**Код записи:** `supabase/functions/_shared/usageAnalytics.ts`

| Вызов | Когда | Функция логирования |
|--------|--------|---------------------|
| Ответ в чате | После каждого успешного `staysee-chat` | `buildUsageLogRow` + `logOpenRouterUsage` (фон, `waitUntil`; в `summary_tokens` входит архив чата) |
| Обновление памяти беседы | Eager + фоновый refresh сводки | `logSummaryGenerationUsage` в `summaryRefresh.ts` |
| Эмбеддинги архива | Индексация + запрос (OpenRouter embeddings) | Стоимость через OpenRouter; в `ai_usage_logs` пока в общем чате (отдельная строка — позже) |
| Сквозная память (LLM) | После синтеза `user_memory` | `logLifeMemorySynthesisUsage` в `userLifeMemory.ts` |

Фоновые записи не блокируют ответ пользователю; eager refresh сводки пишет usage до ответа (нужен актуальный контекст).

**Pricing fallback:** `supabase/functions/_shared/openRouterPricing.ts`

**Legacy:** `ai_usage_log` — старая таблица, дублирование опционально через `logUsage`.

---

## Как посмотреть расход за день

### SQL Editor (Supabase Dashboard)

```sql
SELECT * FROM get_usage_cost_today();
```

или view:

```sql
SELECT * FROM v_analytics_daily_cost
WHERE day = (now() AT TIME ZONE 'UTC')::date;
```

### Терминал

```bash
npm run usage:report
```

---

## Как посмотреть стоимость конкретного чата

```sql
SELECT
  conversation_id,
  count(*) AS requests,
  sum(total_tokens) AS tokens,
  sum(cost) AS cost_usd
FROM ai_usage_logs
WHERE conversation_id = 'ВАШ-UUID-БЕСЕДЫ'
GROUP BY conversation_id;
```

```bash
npm run usage:report -- --conversationId 22ADA91C-FBC4-4681-99CB-F2FF4D43B0CD
```

---

## Другие отчёты

| Задача | SQL / RPC |
|--------|-----------|
| По пользователям | `SELECT * FROM get_usage_cost_by_users(now() - interval '7 days');` |
| Дорогие беседы | `SELECT * FROM get_top_expensive_conversations(20);` |
| Токены памяти | `SELECT * FROM get_memory_token_usage();` |
| График по дням (admin) | `SELECT * FROM v_analytics_daily_cost ORDER BY day;` |

Все RPC — только **service_role** (Dashboard SQL Editor, скрипт, будущий admin).

---

## Admin dashboard (архитектура)

| Слой | Файлы |
|------|--------|
| БД | `ai_usage_logs`, views `v_analytics_*`, RPC `get_*` |
| Сервер | `usageAnalytics.ts`, `openRouterPricing.ts` |
| Отчёты | `scripts/usage-report.mjs` |
| Будущий UI | `src/types/analytics.ts` (типы), edge `usage-analytics` или Supabase RPC |

Метрики для UI:

- **График расходов** → `v_analytics_daily_cost` / `fetchDailyCostSeries`
- **Стоимость пользователя** → `get_usage_cost_by_users`
- **Стоимость беседы** → `get_top_expensive_conversations` + filter by id
- **Memory system** → `v_analytics_memory_system` / `get_memory_token_usage`

---

## Деплой

```bash
npx supabase db push --yes
npx supabase functions deploy staysee-chat --project-ref jnxrildlwvtxhtiwucbt
```
