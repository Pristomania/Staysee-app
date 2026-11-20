-- 097: the admin panel of the owner, stage 1 (look + labels).
-- Design: docs/superpowers/specs/2026-11-20-admin-panel-design.md. Plan: docs/superpowers/plans/2026-11-20-admin-panel-stage1.md.
--
-- Everything here is closed to people: the tables have row level security with no policy and no right for anon or authenticated,
-- and every admin_* function is executable by the service role only. The edge function admin-api is the only caller: it checks the
-- token, the admin flag and a fresh password entry first, then relays to these functions.
--
--   admin_users                  who may open the panel (a row per admin)
--   account_labels               labels of accounts, each with ONE condition for now: are the costs of such an account
--                                counted as "user" or "technical"
--   account_label_assignments    the label of an account; no row = the default label 'person'
--   admin_audit_log              every change made in the panel (ids only, never an e-mail); append-only

-- ── Tables ───────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.account_labels (
  key        text        PRIMARY KEY CHECK (key ~ '^[a-z_]{1,32}$'),
  title      text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 40),
  color      text,
  cost_class text        NOT NULL DEFAULT 'user' CHECK (cost_class IN ('user', 'technical')),
  sort       integer     NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.account_labels (key, title, color, cost_class, sort) VALUES
  ('person',    'Человек',        '#6b7280', 'user',      10),
  ('owner',     'Настя',          '#c9a96e', 'technical', 20),
  ('family',    'Семья',          '#7c9a6e', 'user',      30),
  ('checker',   'Проверка сайта', '#5b7fa6', 'technical', 40),
  ('technical', 'Тестовый',       '#9b6b6b', 'technical', 50)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.account_label_assignments (
  user_id     uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  label_key   text        NOT NULL REFERENCES public.account_labels(key),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid
);

-- No foreign key from the log to people: the record of what an admin did must outlive the person it was done to (it holds ids only).
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  at             timestamptz NOT NULL DEFAULT now(),
  admin_id       uuid        NOT NULL,
  action         text        NOT NULL,
  target_user_id uuid,
  details        jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target ON public.admin_audit_log (target_user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_at ON public.admin_audit_log (at DESC);

-- Append-only: not even the service role can change or remove a row of the log.
CREATE OR REPLACE FUNCTION public.admin_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_admin_audit_log_rows ON public.admin_audit_log;
CREATE TRIGGER trg_admin_audit_log_rows
  BEFORE UPDATE OR DELETE ON public.admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.admin_audit_log_append_only();

DROP TRIGGER IF EXISTS trg_admin_audit_log_truncate ON public.admin_audit_log;
CREATE TRIGGER trg_admin_audit_log_truncate
  BEFORE TRUNCATE ON public.admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.admin_audit_log_append_only();

-- ── Rights: closed to people ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.admin_users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_labels            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_label_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log           ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.admin_users               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.account_labels            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.account_label_assignments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.admin_audit_log           FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.admin_users               TO service_role;
GRANT ALL ON public.account_labels            TO service_role;
GRANT ALL ON public.account_label_assignments TO service_role;
GRANT ALL ON public.admin_audit_log           TO service_role;

-- ── Functions (service role only) ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_is_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.admin_list_labels()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('key', key, 'title', title, 'color', color, 'cost_class', cost_class) ORDER BY sort, key),
    '[]'::jsonb
  )
  FROM public.account_labels;
$$;

-- Puts a label on an account and writes ONE audit row in the same transaction. The caller is re-checked here as well as in the
-- edge function: a function that changes data does not trust that someone else already looked.
CREATE OR REPLACE FUNCTION public.admin_set_label(p_admin_id uuid, p_user_id uuid, p_label_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previous text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = p_admin_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'unknown_user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_labels WHERE key = p_label_key) THEN
    RAISE EXCEPTION 'unknown_label';
  END IF;

  SELECT label_key INTO v_previous FROM public.account_label_assignments WHERE user_id = p_user_id;

  INSERT INTO public.account_label_assignments (user_id, label_key, assigned_by)
  VALUES (p_user_id, p_label_key, p_admin_id)
  ON CONFLICT (user_id) DO UPDATE
    SET label_key = EXCLUDED.label_key, assigned_at = now(), assigned_by = EXCLUDED.assigned_by;

  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, details)
  VALUES (p_admin_id, 'set_label', p_user_id, jsonb_build_object('from', v_previous, 'to', p_label_key));

  RETURN jsonb_build_object('user_id', p_user_id, 'label_key', p_label_key, 'previous_label_key', v_previous);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_is_admin(uuid)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_list_labels()                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_label(uuid, uuid, text)     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_is_admin(uuid)               TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_labels()                TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_label(uuid, uuid, text)  TO service_role;
