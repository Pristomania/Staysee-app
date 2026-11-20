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

-- ── Read functions (service role only; all return jsonb) ─────────────────────────────────────────────────

-- Which class a cost belongs to: a row marked 'technical' (manual runs, transfers) is always technical; otherwise the class comes from
-- the label of the account that caused it ('user' when the account has no label or the label says user).
CREATE OR REPLACE FUNCTION public.admin_cost_class(p_cost_category text, p_label_cost_class text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_cost_category = 'technical' THEN 'technical' ELSE coalesce(p_label_cost_class, 'user') END;
$$;

-- People: search by the start of the e-mail (case does not matter; the characters % _ and the backslash are plain characters),
-- filter by label, pages of 1..100.
CREATE OR REPLACE FUNCTION public.admin_people(
  p_search text DEFAULT NULL,
  p_label  text DEFAULT NULL,
  p_limit  integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit   integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset  integer := greatest(coalesce(p_offset, 0), 0);
  v_text    text    := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
BEGIN
  IF v_text IS NOT NULL THEN
    -- The backslash is the escape character: double it first, then protect % and _ so that they stand for themselves.
    v_pattern := replace(replace(replace(lower(v_text), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  RETURN (
    WITH filtered AS (
      SELECT u.id, u.created_at
      FROM auth.users u
      LEFT JOIN public.account_label_assignments a ON a.user_id = u.id
      WHERE (v_pattern IS NULL OR lower(u.email::text) LIKE v_pattern ESCAPE '\')
        AND (p_label IS NULL OR coalesce(a.label_key, 'person') = p_label)
    ),
    page AS (
      SELECT id FROM filtered ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM filtered),
      'rows', coalesce((
        SELECT jsonb_agg(q.row ORDER BY q.created_at DESC)
        FROM (
          SELECT
            u.created_at,
            jsonb_build_object(
              'user_id', u.id,
              'email', u.email::text,
              'registered_at', u.created_at,
              'last_sign_in_at', u.last_sign_in_at,
              'label_key', coalesce(a.label_key, 'person'),
              'label_title', coalesce(l.title, 'Человек'),
              'tier', t.tier,
              'conversations', (SELECT count(*) FROM public.conversations c WHERE c.user_id = u.id),
              'user_messages', (
                SELECT count(*) FROM public.messages m
                JOIN public.conversations c ON c.id = m.conversation_id
                WHERE c.user_id = u.id AND m.sender = 'user'
              ),
              'cost_user_usd', (
                SELECT coalesce(sum(x.cost), 0) FROM public.ai_usage_logs x
                WHERE x.user_id = u.id AND x.created_at >= now() - interval '30 days'
                  AND public.admin_cost_class(x.cost_category, l.cost_class) = 'user'
              ),
              'cost_technical_usd', (
                SELECT coalesce(sum(x.cost), 0) FROM public.ai_usage_logs x
                WHERE x.user_id = u.id AND x.created_at >= now() - interval '30 days'
                  AND public.admin_cost_class(x.cost_category, l.cost_class) = 'technical'
              )
            ) AS row
          FROM page p
          JOIN auth.users u ON u.id = p.id
          LEFT JOIN public.account_label_assignments a ON a.user_id = u.id
          LEFT JOIN public.account_labels l ON l.key = coalesce(a.label_key, 'person')
          LEFT JOIN public.user_usage_tiers t ON t.user_id = u.id
        ) q
      ), '[]'::jsonb)
    )
  );
END;
$$;

-- One person for support: registration, last login, label, tier, consents, packs, costs by kind (30 days), ratings, errors (7 days).
-- Unknown person: null.
CREATE OR REPLACE FUNCTION public.admin_person_card(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_person jsonb;
  v_class  text;
BEGIN
  SELECT
    jsonb_build_object(
      'user_id', u.id,
      'email', u.email::text,
      'registered_at', u.created_at,
      'last_sign_in_at', u.last_sign_in_at,
      'label_key', coalesce(a.label_key, 'person'),
      'label_title', coalesce(l.title, 'Человек'),
      'tier', t.tier,
      'conversations', (SELECT count(*) FROM public.conversations c WHERE c.user_id = u.id),
      'user_messages', (
        SELECT count(*) FROM public.messages m
        JOIN public.conversations c ON c.id = m.conversation_id
        WHERE c.user_id = u.id AND m.sender = 'user'
      )
    ),
    coalesce(l.cost_class, 'user')
  INTO v_person, v_class
  FROM auth.users u
  LEFT JOIN public.account_label_assignments a ON a.user_id = u.id
  LEFT JOIN public.account_labels l ON l.key = coalesce(a.label_key, 'person')
  LEFT JOIN public.user_usage_tiers t ON t.user_id = u.id
  WHERE u.id = p_user_id;

  IF v_person IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'person', v_person,
    'consents', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('consent_type', c.consent_type, 'document_version', c.document_version, 'consented_at', c.consented_at) ORDER BY c.consented_at), '[]'::jsonb)
      FROM public.user_consents c WHERE c.user_id = p_user_id
    ),
    'tier', (
      SELECT jsonb_build_object('tier', t.tier, 'max_conversations_override', t.max_conversations_override, 'is_suspended', t.is_suspended)
      FROM public.user_usage_tiers t WHERE t.user_id = p_user_id
    ),
    'packs', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('messages_total', p.messages_total, 'messages_left', p.messages_left, 'purchased_at', p.purchased_at, 'expires_at', p.expires_at) ORDER BY p.purchased_at DESC), '[]'::jsonb)
      FROM public.message_packs p WHERE p.user_id = p_user_id
    ),
    'costs', jsonb_build_object('by_kind', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('cost_class', q.cls, 'kind', q.kind, 'calls', q.calls, 'usd', q.usd) ORDER BY q.usd DESC), '[]'::jsonb)
      FROM (
        SELECT public.admin_cost_class(x.cost_category, v_class) AS cls, coalesce(x.call_kind, 'reply') AS kind, count(*) AS calls, sum(x.cost) AS usd
        FROM public.ai_usage_logs x
        WHERE x.user_id = p_user_id AND x.created_at >= now() - interval '30 days'
        GROUP BY 1, 2
      ) q
    )),
    'feedback', jsonb_build_object(
      'answers', jsonb_build_object(
        'up',   (SELECT count(*) FROM public.message_feedback f WHERE f.user_id = p_user_id AND f.rating = 1),
        'down', (SELECT count(*) FROM public.message_feedback f WHERE f.user_id = p_user_id AND f.rating = -1)
      ),
      'dynamics', jsonb_build_object(
        'up',   (SELECT count(*) FROM public.dynamics_feedback f WHERE f.user_id = p_user_id AND f.rating = 1),
        'down', (SELECT count(*) FROM public.dynamics_feedback f WHERE f.user_id = p_user_id AND f.rating = -1)
      )
    ),
    'errors_7d', (
      SELECT count(*) FROM public.ai_usage_logs x
      WHERE x.user_id = p_user_id AND x.error_code IS NOT NULL AND x.created_at >= now() - interval '7 days'
    )
  );
END;
$$;

-- The numbers of the front page.
CREATE OR REPLACE FUNCTION public.admin_overview(p_since timestamptz DEFAULT now() - interval '30 days')
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'people', jsonb_build_object(
      'total', (SELECT count(*) FROM auth.users),
      'registered_7d', (SELECT count(*) FROM auth.users WHERE created_at >= now() - interval '7 days'),
      'registered_30d', (SELECT count(*) FROM auth.users WHERE created_at >= now() - interval '30 days'),
      'by_label', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key', q.key, 'title', q.title, 'count', q.n) ORDER BY q.sort, q.key), '[]'::jsonb)
        FROM (
          SELECT l.key, l.title, l.sort, count(*) AS n
          FROM auth.users u
          LEFT JOIN public.account_label_assignments a ON a.user_id = u.id
          JOIN public.account_labels l ON l.key = coalesce(a.label_key, 'person')
          GROUP BY l.key, l.title, l.sort
        ) q
      ),
      'by_tier', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('tier', q.tier, 'count', q.n) ORDER BY q.n DESC, q.tier), '[]'::jsonb)
        FROM (
          SELECT coalesce(t.tier, 'free') AS tier, count(*) AS n
          FROM auth.users u LEFT JOIN public.user_usage_tiers t ON t.user_id = u.id
          GROUP BY 1
        ) q
      )
    ),
    'costs', (
      SELECT jsonb_build_object(
        'user_usd', coalesce(sum(x.cost) FILTER (WHERE public.admin_cost_class(x.cost_category, l.cost_class) = 'user'), 0),
        'technical_usd', coalesce(sum(x.cost) FILTER (WHERE public.admin_cost_class(x.cost_category, l.cost_class) = 'technical'), 0)
      )
      FROM public.ai_usage_logs x
      LEFT JOIN public.account_label_assignments a ON a.user_id = x.user_id
      LEFT JOIN public.account_labels l ON l.key = coalesce(a.label_key, 'person')
      WHERE x.created_at >= p_since
    ),
    'errors_7d', (SELECT count(*) FROM public.ai_usage_logs WHERE error_code IS NOT NULL AND created_at >= now() - interval '7 days'),
    'feedback', jsonb_build_object(
      'answers', jsonb_build_object(
        'up',   (SELECT count(*) FROM public.message_feedback WHERE rating = 1),
        'down', (SELECT count(*) FROM public.message_feedback WHERE rating = -1)
      ),
      'dynamics', jsonb_build_object(
        'up',   (SELECT count(*) FROM public.dynamics_feedback WHERE rating = 1),
        'down', (SELECT count(*) FROM public.dynamics_feedback WHERE rating = -1)
      )
    )
  );
$$;

-- Costs of a period, split into user and technical: totals, by day (Moscow days), by kind and by person (top 20).
CREATE OR REPLACE FUNCTION public.admin_costs(p_since timestamptz, p_until timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH x AS (
    SELECT l.created_at, l.user_id, l.cost, coalesce(l.call_kind, 'reply') AS kind,
           public.admin_cost_class(l.cost_category, lb.cost_class) AS cls
    FROM public.ai_usage_logs l
    LEFT JOIN public.account_label_assignments a ON a.user_id = l.user_id
    LEFT JOIN public.account_labels lb ON lb.key = coalesce(a.label_key, 'person')
    WHERE l.created_at >= p_since AND l.created_at < p_until
  )
  SELECT jsonb_build_object(
    'totals', jsonb_build_object(
      'user_usd', coalesce((SELECT sum(cost) FROM x WHERE cls = 'user'), 0),
      'technical_usd', coalesce((SELECT sum(cost) FROM x WHERE cls = 'technical'), 0)
    ),
    'by_day', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('day', q.d, 'cost_class', q.cls, 'usd', q.s) ORDER BY q.d, q.cls), '[]'::jsonb)
      FROM (SELECT (created_at AT TIME ZONE 'Europe/Moscow')::date AS d, cls, sum(cost) AS s FROM x GROUP BY 1, 2) q
    ),
    'by_kind', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('cost_class', q.cls, 'kind', q.kind, 'calls', q.n, 'usd', q.s) ORDER BY q.s DESC), '[]'::jsonb)
      FROM (SELECT cls, kind, count(*) AS n, sum(cost) AS s FROM x GROUP BY 1, 2) q
    ),
    'by_person', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', q.user_id, 'email', q.email, 'cost_class', q.cls, 'usd', q.s) ORDER BY q.s DESC), '[]'::jsonb)
      FROM (
        SELECT p.user_id, u.email::text AS email, p.cls, p.s
        FROM (SELECT user_id, cls, sum(cost) AS s FROM x GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20) p
        LEFT JOIN auth.users u ON u.id = p.user_id
      ) q
    )
  );
$$;

-- Ratings (answers or dynamics) with the e-mail of the person, the rated text and the note, newest first.
CREATE OR REPLACE FUNCTION public.admin_feedback(
  p_kind   text,
  p_rating integer DEFAULT NULL,
  p_limit  integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total  bigint;
  v_rows   jsonb;
BEGIN
  IF p_kind = 'answers' THEN
    SELECT count(*) INTO v_total FROM public.message_feedback_review r WHERE p_rating IS NULL OR r.rating = p_rating;
    SELECT coalesce(jsonb_agg(q.row ORDER BY q.created_at DESC), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT r.created_at, jsonb_build_object(
        'created_at', r.created_at, 'verdict', r.verdict, 'rating', r.rating, 'comment', r.comment,
        'user_id', r.user_id, 'email', r.email, 'tier', r.tier, 'conversation_id', r.conversation_id,
        'message_id', r.message_id, 'reply_excerpt', r.reply_excerpt, 'previous_user_message', r.previous_user_message
      ) AS row
      FROM public.message_feedback_review r
      WHERE p_rating IS NULL OR r.rating = p_rating
      ORDER BY r.created_at DESC LIMIT v_limit OFFSET v_offset
    ) q;
  ELSIF p_kind = 'dynamics' THEN
    SELECT count(*) INTO v_total FROM public.dynamics_feedback_review r WHERE p_rating IS NULL OR r.rating = p_rating;
    SELECT coalesce(jsonb_agg(q.row ORDER BY q.created_at DESC), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT r.created_at, jsonb_build_object(
        'created_at', r.created_at, 'verdict', r.verdict, 'rating', r.rating, 'comment', r.comment,
        'user_id', r.user_id, 'email', r.email, 'tier', r.tier, 'conversation_id', r.conversation_id,
        'entry_id', r.entry_id, 'entry_date', r.entry_date, 'dynamics_excerpt', r.dynamics_excerpt
      ) AS row
      FROM public.dynamics_feedback_review r
      WHERE p_rating IS NULL OR r.rating = p_rating
      ORDER BY r.created_at DESC LIMIT v_limit OFFSET v_offset
    ) q;
  ELSE
    RAISE EXCEPTION 'bad_kind';
  END IF;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows);
END;
$$;

-- Errors from the usage log: counts by code and the latest ones (the message is cut to 200 characters).
CREATE OR REPLACE FUNCTION public.admin_errors(p_since timestamptz DEFAULT now() - interval '7 days', p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'by_code', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('error_code', q.error_code, 'count', q.n) ORDER BY q.n DESC, q.error_code), '[]'::jsonb)
      FROM (
        SELECT error_code, count(*) AS n FROM public.ai_usage_logs
        WHERE error_code IS NOT NULL AND created_at >= p_since
        GROUP BY error_code ORDER BY n DESC LIMIT 50
      ) q
    ),
    'recent', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'created_at', q.created_at, 'model', q.model, 'call_kind', q.call_kind,
        'error_code', q.error_code, 'error_message', left(q.error_message, 200), 'user_id', q.user_id
      ) ORDER BY q.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT created_at, model, call_kind, error_code, error_message, user_id FROM public.ai_usage_logs
        WHERE error_code IS NOT NULL AND created_at >= p_since
        ORDER BY created_at DESC LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)
      ) q
    )
  );
$$;

REVOKE ALL ON FUNCTION public.admin_cost_class(text, text)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_people(text, text, integer, integer)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_person_card(uuid)                             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_overview(timestamptz)                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_costs(timestamptz, timestamptz)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_feedback(text, integer, integer, integer)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_errors(timestamptz, integer)                  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cost_class(text, text)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_people(text, text, integer, integer)       TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_person_card(uuid)                          TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_overview(timestamptz)                      TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_costs(timestamptz, timestamptz)            TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_feedback(text, integer, integer, integer)  TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_errors(timestamptz, integer)               TO service_role;
