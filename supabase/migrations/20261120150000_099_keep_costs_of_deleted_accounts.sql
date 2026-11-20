-- 099: the cost of a call is never lost. Before a person's account or room goes, the cost rows of that person are kept, cut loose from the
-- person and marked as belonging to a deleted account; calls made outside the app can be written here too (no person at all).
--
-- Why: the admin panel counts money from ai_usage_logs, and the money was disappearing twice: request_room_deletion() deleted the rows of the
-- person, and the foreign key to auth.users deleted them with the account (ON DELETE CASCADE). The owner wants every cost counted, the deleted
-- accounts too (marked as deleted), and everything run outside the app too.
--
-- What stays on a row after the person is cut loose: when, which model, how many tokens, the cost, what the call was for, how it ended
-- (code only). What goes: the person (user_id), the conversation, the provider's request id and the text of an error message (it can quote
-- what was asked). The label the account had is kept as a word, so a deleted test account still counts as technical.
--
-- Rows of a deleted account:   user_id IS NULL AND account_deleted_at IS NOT NULL
-- Rows made outside the app:   user_id IS NULL AND account_deleted_at IS NULL   (cost_category 'technical', call_kind 'offapp:<what>')

-- ── Table ────────────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ai_usage_logs
  ADD COLUMN IF NOT EXISTS account_deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS account_label_key  text;

ALTER TABLE public.ai_usage_logs ALTER COLUMN user_id DROP NOT NULL;

-- Not CASCADE any more: whatever deletes an account (the purge, a dashboard, a test) leaves the cost behind.
ALTER TABLE public.ai_usage_logs DROP CONSTRAINT IF EXISTS ai_usage_logs_user_id_fkey;
ALTER TABLE public.ai_usage_logs
  ADD CONSTRAINT ai_usage_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── Keeping the cost ─────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._keep_usage_costs(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.ai_usage_logs x
  SET account_label_key  = coalesce((SELECT a.label_key FROM public.account_label_assignments a WHERE a.user_id = p_user_id), 'person'),
      account_deleted_at = now(),
      user_id            = NULL,
      conversation_id    = NULL,
      request_id         = NULL,
      error_message      = NULL
  WHERE x.user_id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public._keep_usage_costs(uuid) FROM PUBLIC, anon, authenticated;

-- Whatever way an account is removed, its cost rows are cut loose first (this runs before the foreign key acts, and before the label row
-- of the account goes with it).
CREATE OR REPLACE FUNCTION public._keep_usage_costs_on_account_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public._keep_usage_costs(OLD.id);
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public._keep_usage_costs_on_account_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_keep_usage_costs_on_account_delete ON auth.users;
CREATE TRIGGER trg_keep_usage_costs_on_account_delete
  BEFORE DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public._keep_usage_costs_on_account_delete();

-- ── Room deletion: the same as 093, except that the cost rows are kept instead of deleted ───────────────────

CREATE OR REPLACE FUNCTION public.request_room_deletion()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_purge_at timestamptz := ((now() AT TIME ZONE 'utc')::date + interval '3 months' + interval '1 day') AT TIME ZONE 'utc';
  v_existing timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- Asked before and fully recorded: the same date again, nothing is deleted twice. A half-written request (a date
  -- missing) is done again, so that the clean-up always has a date to stand on.
  SELECT room_purge_after INTO v_existing
  FROM public.profiles
  WHERE id = v_uid AND room_deletion_requested_at IS NOT NULL AND room_purge_after IS NOT NULL;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  PERFORM public._wipe_account_content(v_uid);
  PERFORM public._keep_usage_costs(v_uid);
  DELETE FROM public.user_usage_tiers WHERE user_id = v_uid;

  -- The profile may be missing (an account made before profiles were filled in): make it, so that the sign-in block and
  -- the 3 months have something to stand on.
  INSERT INTO public.profiles (id, room_deletion_requested_at, room_purge_after, cross_memory_enabled)
  VALUES (v_uid, now(), v_purge_at, true)
  ON CONFLICT (id) DO UPDATE
    SET room_deletion_requested_at = now(),
        room_purge_after = v_purge_at,
        cross_memory_enabled = true;

  RETURN v_purge_at;
END;
$$;

REVOKE ALL ON FUNCTION public.request_room_deletion() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_room_deletion() FROM anon;
GRANT EXECUTE ON FUNCTION public.request_room_deletion() TO authenticated;

-- ── The panel counts them ────────────────────────────────────────────────────────────────────────────────
-- The label of a row is the label the account has now; a row of a deleted account has the label the account had when it went; a row made
-- outside the app has none and is technical (its cost_category says so).

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
      LEFT JOIN public.account_labels l ON l.key = coalesce(a.label_key, x.account_label_key, 'person')
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

-- by_person: who = 'account' (a person, user_id and e-mail given), 'deleted' (all the deleted accounts together) or 'off_app' (all the calls
-- made outside the app together); the last two have no user_id and no e-mail.
CREATE OR REPLACE FUNCTION public.admin_costs(p_since timestamptz, p_until timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH x AS (
    SELECT l.created_at, l.user_id, l.cost, coalesce(l.call_kind, 'reply') AS kind,
           CASE WHEN l.user_id IS NOT NULL THEN 'account'
                WHEN l.account_deleted_at IS NOT NULL THEN 'deleted'
                ELSE 'off_app' END AS who,
           public.admin_cost_class(l.cost_category, lb.cost_class) AS cls
    FROM public.ai_usage_logs l
    LEFT JOIN public.account_label_assignments a ON a.user_id = l.user_id
    LEFT JOIN public.account_labels lb ON lb.key = coalesce(a.label_key, l.account_label_key, 'person')
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
      SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', q.user_id, 'email', q.email, 'who', q.who, 'cost_class', q.cls, 'usd', q.s) ORDER BY q.s DESC), '[]'::jsonb)
      FROM (
        SELECT p.user_id, u.email::text AS email, p.who, p.cls, p.s
        FROM (SELECT user_id, who, cls, sum(cost) AS s FROM x GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 20) p
        LEFT JOIN auth.users u ON u.id = p.user_id
      ) q
    )
  );
$$;
