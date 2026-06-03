# Удаление комнаты (пространства пользователя)

## Поведение

1. В **Контекст** → «Удалить комнату» — двухшаговое подтверждение.
2. RPC `request_room_deletion()` сразу удаляет беседы, сообщения, память, embeddings, дневник прогресса, счётчики usage.
3. В `profiles` ставятся `room_deletion_requested_at` и `room_purge_after` (= now + **14 дней**).
4. Пользователь выходит; повторный вход блокируется («комната удалена»).
5. Через 14 дней cron вызывает Edge Function `purge-scheduled-rooms` → `list_rooms_ready_for_purge()` + `auth.admin.deleteUser` (профиль каскадом).

Восстановления в UI нет.

## Миграция

```bash
npx supabase db push
```

## Cron (прод)

1. Задайте секрет в Edge Functions: `PURGE_ROOMS_SECRET` (или `CRON_SECRET`).
2. Раз в сутки POST на  
   `https://<project>.supabase.co/functions/v1/purge-scheduled-rooms`  
   с заголовком `X-Purge-Secret: <secret>`.

Пример (GitHub Actions / cron на VPS):

```bash
curl -sS -X POST "$SUPABASE_URL/functions/v1/purge-scheduled-rooms" \
  -H "X-Purge-Secret: $PURGE_ROOMS_SECRET" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"
```

3. Задеплойте функцию:  
   `npx supabase functions deploy purge-scheduled-rooms --project-ref <ref>`
