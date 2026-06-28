# План: логирование согласий на ОПД (user_consents)

**Цель:** выполнить требование ст. 9 152-ФЗ — хранить доказательство того, что пользователь дал согласие на обработку персональных данных (дата, IP, устройство, версия документа).

**Затрагивает:** 1 новая миграция Supabase + правки в RegisterScreen.tsx

---

## Шаг 1. Миграция Supabase

Создать файл: `supabase/migrations/20260628140000_030_user_consents.sql`

```sql
-- Таблица для хранения юридически значимых согласий пользователей (152-ФЗ ст. 9)
CREATE TABLE IF NOT EXISTS public.user_consents (
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  consent_type  TEXT        NOT NULL,
  document_hash TEXT        NOT NULL,
  consented_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address    TEXT,
  user_agent    TEXT,
  PRIMARY KEY (user_id, consent_type)
);

-- Только сам пользователь может читать свои согласия
ALTER TABLE public.user_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_consents: owner read"
  ON public.user_consents FOR SELECT
  USING (auth.uid() = user_id);

-- Запись создаётся только через service_role (из edge function или при signUp)
-- Прямая вставка от клиента запрещена
CREATE POLICY "user_consents: no direct insert"
  ON public.user_consents FOR INSERT
  WITH CHECK (false);
```

**Важно перед применением:**
- Проверить что таблица `user_consents` ещё не существует (`\dt public.user_consents` в psql)
- Применить через `supabase db push` или Supabase Dashboard → SQL Editor
- После применения убедиться что таблица появилась в Dashboard → Table Editor

---

## Шаг 2. Хэши документов

Текущие версии документов (зафиксировать в коде как константы):

| Документ | consent_type | document_hash |
|---|---|---|
| Пользовательское соглашение v1.1 | `terms_v1.1` | `offer-2026-06-28-v1.1` |
| Политика ПД v1.1 | `privacy_v1.1` | `privacy-2026-06-28-v1.1` |

При выпуске новой редакции документа — обновить `consent_type` и `document_hash`. Пользователи с устаревшей версией должны будут принять заново.

---

## Шаг 3. Запись согласий при регистрации

Файл: `src/components/screens/RegisterScreen.tsx`

После успешного `signUp` (когда `result.status === 'confirm_email'` или `result.status === 'session'`) — записать согласия.

**Проблема:** сразу после `signUp` у нас может не быть `user.id` (если требуется подтверждение email). В таком случае запись делается при первом входе (onAuthStateChange → session появился).

**Вариант А — запись при подтверждении email (рекомендуется):**

Добавить в `AuthContext` или в хук `onAuthStateChange` — при первом появлении сессии проверить есть ли запись в `user_consents`. Если нет — записать.

```typescript
// src/lib/recordConsents.ts — новый файл

import { supabase } from './supabase';

const CONSENTS = [
  { consent_type: 'terms_v1.1',   document_hash: 'offer-2026-06-28-v1.1' },
  { consent_type: 'privacy_v1.1', document_hash: 'privacy-2026-06-28-v1.1' },
];

export async function recordConsentsIfNeeded(userId: string): Promise<void> {
  // Проверяем есть ли уже записи
  const { data } = await supabase
    .from('user_consents')
    .select('consent_type')
    .eq('user_id', userId);

  const existing = new Set((data ?? []).map((r) => r.consent_type));
  const missing = CONSENTS.filter((c) => !existing.has(c.consent_type));
  if (missing.length === 0) return;

  // IP и user_agent — получаем на клиенте
  const userAgent = navigator.userAgent;

  await supabase.from('user_consents').insert(
    missing.map((c) => ({
      user_id: userId,
      consent_type: c.consent_type,
      document_hash: c.document_hash,
      user_agent: userAgent,
      // ip_address: определяется на сервере (см. Вариант Б)
    }))
  );
}
```

Вызвать `recordConsentsIfNeeded(user.id)` в `AuthContext` при появлении новой сессии:

```typescript
// Внутри onAuthStateChange, когда event === 'SIGNED_IN':
if (session?.user) {
  recordConsentsIfNeeded(session.user.id);
}
```

**Вариант Б — запись через Edge Function (если нужен IP):**

IP-адрес клиента нельзя получить надёжно на фронтенде (прокси, VPN). Если IP важен — создать edge function `record-consent`, которая принимает `{ consent_types, document_hashes }`, получает IP из заголовка запроса (`x-forwarded-for`) и пишет в таблицу через service role.

Это усложнение — для первого релиза достаточно Варианта А без IP.

---

## Шаг 4. Проверка что всё работает

1. Зарегистрировать тестового пользователя через UI
2. В Supabase Dashboard → Table Editor → `user_consents` убедиться что появились две строки:
   - `terms_v1.1` с датой и user_agent
   - `privacy_v1.1` с датой и user_agent
3. Убедиться что `user_id` совпадает с `auth.users.id` нового пользователя

---

## Итог

После реализации:
- Каждый новый пользователь имеет юридически зафиксированное согласие с датой и устройством
- При смене версии документа — старые согласия остаются, новые пишутся с новым `consent_type`
- Доказательство согласия хранится в базе и защищено RLS

**Что НЕ делать:**
- Не давать клиенту прямой INSERT в эту таблицу (политика RLS запрещает)
- Не удалять записи при удалении пользователем своих данных (хранить 3 года как доказательство)
