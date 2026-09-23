-- Adds a nullable topic classification to both Memory V3 item tables, so the
-- viewer screen can group records by subject (Люди/Факты/Предпочтения for
-- dialogue scope, Факты профиля/Стиль общения/Что помогает в контакте for
-- lifecycle scope) instead of by event/recurrence kind. Nullable because a
-- migration is instant but classifying the handful of pre-existing rows
-- needs one AI call per row (see the standalone backfill script) -- the two
-- steps cannot happen atomically. NOT NULL is intentionally not enforced;
-- the viewer groups any null-topic row into a "Разное" bucket until the
-- backfill (or the next revise) fills it in.

ALTER TABLE public.memory_v3_lifecycle_shadow_items
  ADD COLUMN IF NOT EXISTS topic text NULL
    CHECK (topic IS NULL OR topic IN ('life_context', 'communication', 'preference'));

ALTER TABLE public.memory_v3_dialogue_items
  ADD COLUMN IF NOT EXISTS topic text NULL
    CHECK (topic IS NULL OR topic IN ('person', 'fact', 'preference'));
