# QA — StaySee (prod)

Проект Supabase: `jnxrildlwvtxhtiwucbt`

## Деплой

```bash
npx supabase db push
npx supabase functions deploy staysee-chat --project-ref jnxrildlwvtxhtiwucbt
```

Переменные edge: `OPENROUTER_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.  
Модели по глубине: см. [MODEL_ROUTING.md](./MODEL_ROUTING.md).

## Память (чат «Сокровенное» или любой длинный)

| # | Действие | Ожидание |
|---|----------|----------|
| 1 | «Помнишь, я говорила про отношения с мужчиной?» | Не «ты не говорила»; опора на прошлые реплики |
| 2 | «Как было прошлым летом, когда он предавал?» | Упоминание истории из чата, не с нуля |
| 3 | Длинный эмоциональный ответ | Без обрыва на «—» / полуслове; без «напиши дальше» |
| 4 | Сквозная память | Пункт в другом чате не подмешивается в ответ этого чата |

## Embeddings (если архив слабый)

```bash
npm run backfill:embeddings
```

Нужны в `.env`: `VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`.

## Логи (Dashboard → Functions → staysee-chat)

- `[retrieval] ... evidence=N` — сколько цитат пользователя в промпт
- `[staysee-chat] completion segments=N` — автодописание ответа
- `[retrieval] merged=N` — размер архива в промпте

## Записки себе (отдельный экран в беседе)

Перо в чате → экран **«Записки себе»**:
- **Выписываю важное** — инсайт / точка напряжения;
- **Динамика недели** — AI (`weekly-reflection`), не чаще 1 раза в 7 дней; **Мои записки**: вкладки **Инсайты** · **Напряжение** · **Вся динамика**; запись — **+** в закреплённой нижней панели (компактный sheet).

Деплой: `npx supabase functions deploy weekly-reflection` · миграция `018_progress_entry_types`
