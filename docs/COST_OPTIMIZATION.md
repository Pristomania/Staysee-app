# Экономия без потери памяти и глубины

## Что не трогали (определяющие функции)

- **ПАМЯТЬ БЕСЕДЫ** — rolling summary на `conversations`, eager refresh при устаревании.
- **Сквозная память** — `user_memory`, до 8 пунктов в каждом ответе.
- **Хвост реплик** — tier trim 12–20 сообщений.
- **Глубина ответа** — `responseBudget.ts` (brief / medium / deep), без урезания лимитов токенов.
- **Роутинг моделей** — Haiku / GPT 4.1 по глубине.

## Что изменили

### 1. Архив и цитаты — по необходимости

`resolveArchiveRetrievalMode` в `conversationRetrieval.ts`:

| Режим | Когда | Что грузится |
|-------|--------|----------------|
| **off** | «Устала», короткие реплики | Только summary + tail + cross-memory |
| **light** | 2+ слова в сообщении, длинная рефлексия (180+ символов) | До 4 фрагментов архива, без embeddings и без дословных цитат |
| **full** | «помнишь», «мы говорили», продолжение темы | Полный архив + semantic search + ПОДТВЕРЖДЁННЫЕ СЛОВА |

**Важно:** раньше в поиск архива попадал текст **summary** (`combinedQuery`), из‑за чего архив подмешивался почти на каждый ход. Теперь ключевые слова — только из **текущего сообщения**.

### 2. Меньше «отзеркаливания»

Правки в `identity.ts`, `methodology.ts`, `presence.ts`, `stance.ts` — короче ответы, та же эмоциональная точность.

### 3. Auto-continue

`MAX_AUTO_CONTINUE_SEGMENTS`: 8 → **5** (ответ по-прежнему дописывается до цельного предложения).

## Деплой

```bash
npx supabase functions deploy staysee-chat --project-ref jnxrildlwvtxhtiwucbt
```

## Проверка в логах

- Обычное сообщение: `[retrieval] ... skipped mode=off`
- Вопрос про прошлое: `mode=full`, `evidence=N`
- Длинная рефлексия: `mode=light`, `merged=2–4`

Через неделю: `npm run usage:breakdown` — средний `summary_tokens` / prompt должен снизиться.

## Память и «помнишь» (анти-галлюцинации)

См. правки в `memory.ts` (summary только из реплик пользователя), `buildRecallGroundingPrompt`, stance `recall` / `memory_repair`.

## Если что-то просело по качеству

- «Не помню, что говорила» на **full** recall — проверьте `mode=full` в логах.
- Слишком мало контекста на длинных темах без «помнишь» — можно опустить порог light с 180 до 120 символов в `resolveArchiveRetrievalMode`.
