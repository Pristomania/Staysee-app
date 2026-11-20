-- 098: archive content gates. Deploy with the safe-list/mutation client, never alone.
-- No conversation/message content is deleted by this migration.
ALTER TABLE public.user_usage_tiers ADD COLUMN free_conversation_id uuid;
COMMENT ON COLUMN public.user_usage_tiers.free_conversation_id IS
 'Server-owned free slot. No FK deliberately: deleted IDs are tombstones, not next-room unlocks.';
ALTER TABLE public.conversations ADD COLUMN manual_sort_at timestamptz;

CREATE FUNCTION public.conversation_paid_features_for(p_user uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.user_usage_tiers u JOIN public.profiles p ON p.id=u.user_id
 WHERE u.user_id=p_user AND p.room_deletion_requested_at IS NULL AND u.is_suspended IS NOT TRUE
 AND u.tier IN ('basic','premium') AND (u.unlimited_usage IS TRUE OR u.access_source='manual'
 OR (u.access_source='purchase' AND u.paid_access_until>pg_catalog.clock_timestamp())));
$$;
CREATE FUNCTION public.conversation_full_access_for(p_user uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.conversation_paid_features_for(p_user) OR EXISTS(
 SELECT 1 FROM public.user_usage_tiers u JOIN public.profiles p ON p.id=u.user_id
 WHERE u.user_id=p_user AND p.room_deletion_requested_at IS NULL AND u.is_suspended IS NOT TRUE
 AND (u.unlimited_usage IS TRUE OR (u.access_source='manual' AND u.max_conversations_override>1)));
$$;
CREATE FUNCTION public.conversation_allowed_for(p_user uuid,p_conversation uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.conversations c JOIN public.user_usage_tiers u ON u.user_id=c.user_id
 JOIN public.profiles p ON p.id=u.user_id
 WHERE c.id=p_conversation AND c.user_id=p_user AND c.is_active IS TRUE
 AND p.room_deletion_requested_at IS NULL AND u.is_suspended IS NOT TRUE
 AND (public.conversation_full_access_for(p_user) OR c.id=u.free_conversation_id));
$$;
CREATE FUNCTION public.refresh_conversation_anchor(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_top uuid;
BEGIN
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=p_user FOR UPDATE;
 IF NOT FOUND OR NOT public.conversation_full_access_for(p_user) THEN RETURN; END IF;
 SELECT id INTO v_top FROM public.conversations WHERE user_id=p_user AND is_active IS TRUE
 ORDER BY greatest(last_message_at,coalesce(manual_sort_at,last_message_at)) DESC NULLS LAST,created_at DESC NULLS LAST,id DESC LIMIT 1;
 UPDATE public.user_usage_tiers SET free_conversation_id=v_top WHERE user_id=p_user;
END;
$$;

-- Seed once; even already-expired purchases get their current top, never all content.
UPDATE public.user_usage_tiers u SET free_conversation_id=(SELECT c.id FROM public.conversations c
 WHERE c.user_id=u.user_id AND c.is_active IS TRUE
 ORDER BY c.last_message_at DESC NULLS LAST,c.created_at DESC NULLS LAST,c.id DESC LIMIT 1);

CREATE FUNCTION public.conversation_anchor_after_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.refresh_conversation_anchor(CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END);
 RETURN NULL;
END;
$$;
CREATE TRIGGER conversation_anchor_after_change AFTER INSERT OR DELETE OR UPDATE OF last_message_at,manual_sort_at,is_active
 ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.conversation_anchor_after_change();
CREATE FUNCTION public.conversation_anchor_after_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN PERFORM public.refresh_conversation_anchor(NEW.user_id); RETURN NULL; END;
$$;
CREATE TRIGGER conversation_anchor_after_plan AFTER UPDATE OF tier,access_source,paid_access_until,unlimited_usage,max_conversations_override
 ON public.user_usage_tiers FOR EACH ROW EXECUTE FUNCTION public.conversation_anchor_after_plan();

CREATE OR REPLACE FUNCTION public.enforce_conversation_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_usage public.user_usage_tiers%ROWTYPE; v_limit int; v_count int; v_tier text;
BEGIN
 IF NEW.is_active IS NOT TRUE THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.is_active IS TRUE THEN RETURN NEW; END IF;
 SELECT * INTO v_usage FROM public.user_usage_tiers WHERE user_id=NEW.user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'billing_unavailable'; END IF;
 IF NOT public.conversation_full_access_for(NEW.user_id) THEN
   IF EXISTS(SELECT 1 FROM public.conversations WHERE id=v_usage.free_conversation_id AND user_id=NEW.user_id AND is_active IS TRUE)
      OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'conversation_limit_reached'; END IF;
   -- Only a newly inserted empty room can replace a missing/deleted slot, never an archived existing row.
   UPDATE public.user_usage_tiers SET free_conversation_id=NEW.id WHERE user_id=NEW.user_id;
   RETURN NEW;
 END IF;
 v_tier:=CASE WHEN public.conversation_paid_features_for(NEW.user_id) OR v_usage.unlimited_usage IS TRUE THEN v_usage.tier ELSE 'free' END;
 SELECT max_conversations INTO v_limit FROM public.usage_tier_limits WHERE tier=v_tier;
 v_limit:=coalesce(v_usage.max_conversations_override,v_limit,1);
 SELECT count(*) INTO v_count FROM public.conversations WHERE user_id=NEW.user_id AND is_active IS TRUE;
 IF v_count>=v_limit THEN RAISE EXCEPTION 'conversation_limit_reached'; END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION public.can_read_my_conversation(p_conversation_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.conversation_allowed_for(auth.uid(),p_conversation_id);
$$;
CREATE FUNCTION public.has_my_paid_features() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.conversation_paid_features_for(auth.uid());
$$;
CREATE FUNCTION public.get_my_conversation_access(p_conversation_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('allowed',public.conversation_allowed_for(auth.uid(),p_conversation_id),
 'paidFeatures',public.conversation_paid_features_for(auth.uid()),'fullAccess',public.conversation_full_access_for(auth.uid()));
$$;
CREATE FUNCTION public.list_my_conversations() RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'user_id',c.user_id,'title',coalesce(c.title,''),
 'is_active',c.is_active,'created_at',coalesce(c.created_at,c.last_message_at,'epoch'::timestamptz),'last_message_at',coalesce(c.last_message_at,c.created_at,'epoch'::timestamptz),
 'can_read',public.conversation_allowed_for(auth.uid(),c.id))
 ORDER BY greatest(c.last_message_at,coalesce(c.manual_sort_at,c.last_message_at)) DESC NULLS LAST,c.created_at DESC NULLS LAST,c.id DESC),'[]'::jsonb)
 FROM public.conversations c JOIN public.profiles p ON p.id=c.user_id
 WHERE c.user_id=auth.uid() AND c.is_active IS TRUE AND p.room_deletion_requested_at IS NULL;
$$;
CREATE FUNCTION public.delete_my_conversation(p_conversation_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count int;
BEGIN
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=auth.uid() FOR UPDATE;
 DELETE FROM public.conversations WHERE id=p_conversation_id AND user_id=auth.uid();
 GET DIAGNOSTICS v_count=ROW_COUNT; RETURN v_count=1;
END;
$$;
CREATE FUNCTION public.delete_all_my_conversations(p_expected_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS DISTINCT FROM p_expected_user_id THEN RAISE EXCEPTION 'account_changed'; END IF;
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=auth.uid() FOR UPDATE;
 DELETE FROM public.conversations WHERE user_id=auth.uid();
END;
$$;
CREATE FUNCTION public.rename_my_conversation(p_conversation_id uuid,p_title text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count int;
BEGIN
 IF p_title IS NULL OR length(p_title)>200 THEN RAISE EXCEPTION 'invalid_title'; END IF;
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=auth.uid() FOR UPDATE;
 UPDATE public.conversations SET title=coalesce(nullif(btrim(p_title),''),'Новая беседа')
 WHERE id=p_conversation_id AND user_id=auth.uid();
 GET DIAGNOSTICS v_count=ROW_COUNT; RETURN v_count=1;
END;
$$;
CREATE FUNCTION public.move_my_conversation_to_top(p_conversation_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count int;
BEGIN
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=auth.uid() FOR UPDATE;
 IF NOT public.conversation_full_access_for(auth.uid()) THEN RAISE EXCEPTION 'conversation_locked'; END IF;
 UPDATE public.conversations SET manual_sort_at=clock_timestamp()
 WHERE id=p_conversation_id AND user_id=auth.uid() AND is_active IS TRUE;
 GET DIAGNOSTICS v_count=ROW_COUNT; RETURN v_count=1;
END;
$$;
CREATE FUNCTION public.touch_my_conversation(p_conversation_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=auth.uid() FOR UPDATE;
 IF NOT public.conversation_allowed_for(auth.uid(),p_conversation_id) THEN RETURN false; END IF;
 UPDATE public.conversations SET last_message_at=clock_timestamp() WHERE id=p_conversation_id AND user_id=auth.uid();
 RETURN true;
END;
$$;
CREATE FUNCTION public.reserve_ai_request_for_conversation(p_user_id uuid,p_conversation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now timestamptz;
BEGIN
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=p_user_id FOR UPDATE;
 v_now:=clock_timestamp();
 IF NOT public.conversation_allowed_at(p_user_id,p_conversation_id,v_now) THEN
  RETURN jsonb_build_object('allowed',false,'tier','free','reason','conversation_locked');
 END IF;
 RETURN public.reserve_ai_request_at(p_user_id,v_now);
END;
$$;

-- RETURNING on INSERT evaluates policy against NEW before a table lookup can see that row.
-- Use the policy row's owner/id plus the server slot, not a recursive lookup of conversations.
CREATE FUNCTION public.can_read_my_conversation_row(p_owner uuid,p_id uuid,p_active boolean) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT p_owner=auth.uid() AND p_active IS TRUE AND EXISTS(
 SELECT 1 FROM public.user_usage_tiers u JOIN public.profiles p ON p.id=u.user_id
 WHERE u.user_id=auth.uid() AND u.is_suspended IS NOT TRUE AND p.room_deletion_requested_at IS NULL
 AND (public.conversation_full_access_for(auth.uid()) OR u.free_conversation_id=p_id));
$$;
CREATE POLICY archive_conversations_read ON public.conversations AS RESTRICTIVE FOR SELECT TO authenticated
 USING(public.can_read_my_conversation_row(user_id,id,is_active));
CREATE POLICY archive_conversations_create ON public.conversations AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK(user_id=auth.uid() AND EXISTS(SELECT 1 FROM public.user_usage_tiers u JOIN public.profiles p ON p.id=u.user_id
 WHERE u.user_id=auth.uid() AND u.is_suspended IS NOT TRUE AND p.room_deletion_requested_at IS NULL));
CREATE POLICY archive_messages_access ON public.messages AS RESTRICTIVE FOR ALL TO authenticated
 USING(public.can_read_my_conversation(conversation_id)) WITH CHECK(public.can_read_my_conversation(conversation_id));
CREATE OR REPLACE FUNCTION public.load_conversation_last_messages(p_conversation_ids uuid[]) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_object_agg(s.conversation_id,s.content),'{}'::jsonb) FROM (
 SELECT DISTINCT ON(m.conversation_id) m.conversation_id,m.content FROM public.messages m
 WHERE m.conversation_id=ANY(p_conversation_ids) AND public.can_read_my_conversation(m.conversation_id)
 ORDER BY m.conversation_id,m.created_at DESC) s;
$$;

-- Preserve note provenance through the existing ON DELETE SET NULL, not content deletion.
ALTER TABLE public.progress_entries ADD COLUMN origin_conversation_id uuid;
UPDATE public.progress_entries SET origin_conversation_id=conversation_id;
CREATE FUNCTION public.preserve_progress_conversation_origin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 NEW.origin_conversation_id:=CASE WHEN TG_OP='INSERT' THEN NEW.conversation_id
 ELSE coalesce(OLD.origin_conversation_id,OLD.conversation_id,NEW.conversation_id) END;
 RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_progress_conversation_origin BEFORE INSERT OR UPDATE ON public.progress_entries
 FOR EACH ROW EXECUTE FUNCTION public.preserve_progress_conversation_origin();
CREATE POLICY archive_progress_read ON public.progress_entries AS RESTRICTIVE FOR SELECT TO authenticated
 USING((public.has_my_paid_features() OR
 (entry_type<>'weekly' AND ((origin_conversation_id IS NULL AND conversation_id IS NULL)
 OR public.can_read_my_conversation(coalesce(origin_conversation_id,conversation_id))))));
CREATE POLICY archive_user_memory_read ON public.user_memory AS RESTRICTIVE FOR SELECT TO authenticated
 USING(public.has_my_paid_features());
DO $$BEGIN
 IF to_regclass('public.message_embeddings') IS NOT NULL THEN
  EXECUTE 'CREATE POLICY archive_embedding_read ON public.message_embeddings AS RESTRICTIVE FOR SELECT TO authenticated USING(public.can_read_my_conversation(conversation_id))';
 END IF;
 IF to_regclass('public.memory_corrections') IS NOT NULL THEN
  EXECUTE 'CREATE POLICY archive_corrections_read ON public.memory_corrections AS RESTRICTIVE FOR SELECT TO authenticated USING((scope=''global'' AND conversation_id IS NULL AND public.has_my_paid_features()) OR public.can_read_my_conversation(conversation_id))';
 END IF;
END;$$;

-- Raw ordering/deletion cannot bypass the usage-first RPCs or freeze. Keep the settings toggle usable.
REVOKE INSERT,UPDATE,DELETE ON public.conversations FROM PUBLIC,anon,authenticated;
GRANT INSERT(user_id,title,is_active) ON public.conversations TO authenticated;
GRANT UPDATE(cross_memory_enabled) ON public.conversations TO authenticated;

REVOKE ALL ON FUNCTION public.conversation_paid_features_for(uuid),public.conversation_full_access_for(uuid),
 public.conversation_allowed_for(uuid,uuid),public.refresh_conversation_anchor(uuid),
 public.conversation_anchor_after_change(),public.conversation_anchor_after_plan(),
 public.preserve_progress_conversation_origin(),public.enforce_conversation_limit()
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.reserve_ai_request_for_conversation(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.reserve_ai_request_for_conversation(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.can_read_my_conversation(uuid),public.has_my_paid_features(),
 public.can_read_my_conversation_row(uuid,uuid,boolean),
 public.get_my_conversation_access(uuid),public.list_my_conversations(),public.delete_my_conversation(uuid),
 public.delete_all_my_conversations(uuid),public.rename_my_conversation(uuid,text),
 public.move_my_conversation_to_top(uuid),public.touch_my_conversation(uuid),public.load_conversation_last_messages(uuid[])
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.can_read_my_conversation(uuid),public.has_my_paid_features(),
 public.can_read_my_conversation_row(uuid,uuid,boolean),
 public.get_my_conversation_access(uuid),public.list_my_conversations(),public.delete_my_conversation(uuid),
 public.delete_all_my_conversations(uuid),public.rename_my_conversation(uuid,text),
 public.move_my_conversation_to_top(uuid),public.touch_my_conversation(uuid),public.load_conversation_last_messages(uuid[])
 TO authenticated;

-- One captured post-lock time is shared by conversation authorization and quota settlement.
CREATE FUNCTION public.conversation_allowed_at(p_user uuid,p_conversation uuid,p_now timestamptz) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.conversations c JOIN public.user_usage_tiers u ON u.user_id=c.user_id
 JOIN public.profiles p ON p.id=u.user_id WHERE c.id=p_conversation AND c.user_id=p_user AND c.is_active IS TRUE
 AND p.room_deletion_requested_at IS NULL AND u.is_suspended IS NOT TRUE AND
 (c.id=u.free_conversation_id OR u.unlimited_usage IS TRUE OR (u.access_source='manual' AND u.max_conversations_override>1)
 OR (u.tier IN('basic','premium') AND (u.access_source='manual' OR (u.access_source='purchase' AND u.paid_access_until>p_now)))));
$$;
CREATE FUNCTION public.expire_purchased_access_at(p_user_id uuid,p_now timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.user_usage_tiers%ROWTYPE;
BEGIN
 SELECT * INTO u FROM public.user_usage_tiers WHERE user_id=p_user_id FOR UPDATE;
 IF NOT FOUND OR u.unlimited_usage THEN RETURN; END IF;
 IF u.access_source='purchase' AND u.paid_access_until<=p_now AND u.tier<>'free' THEN
  UPDATE public.user_usage_tiers SET tier='free',daily_request_limit=50,period_requests_used=50,
  period_started_at=p_now,updated_at=p_now WHERE user_id=p_user_id;
 END IF;
END;
$$;
CREATE OR REPLACE FUNCTION public.expire_purchased_access(p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=p_user_id FOR UPDATE;
 PERFORM public.expire_purchased_access_at(p_user_id,clock_timestamp());
END;
$$;
CREATE FUNCTION public.reserve_ai_request_at(p_user_id uuid,v_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row          public.user_usage_tiers%ROWTYPE;
  v_limits       public.usage_tier_limits%ROWTYPE;
  v_has_limits   boolean;
  v_day_expired  boolean;
  v_period_used  int;
  v_period_start timestamptz;
  v_spent        numeric := 0;
  v_limit_hit    boolean := false;
  v_cap_hit      boolean := false;
  v_pack_id      uuid;
  v_use_pack     boolean := false;
  v_open_packs   int;
  v_allowance    numeric;
BEGIN
  PERFORM public.expire_purchased_access_at(p_user_id,v_now);
  SELECT *
  INTO v_row
  FROM public.user_usage_tiers
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
      'allowed', false,
      'tier', 'free',
      'reason', 'missing_tier'
    );
  END IF;

  IF v_row.is_suspended THEN
    RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
      'allowed', false,
      'tier', v_row.tier,
      'reason', 'suspended'
    );
  END IF;

  v_day_expired := v_now - v_row.day_reset_at > interval '24 hours';

  -- Unlimited: let through before any limit; the counters and the clock still run.
  IF v_row.unlimited_usage THEN
    UPDATE public.user_usage_tiers
    SET
      daily_requests_used = CASE WHEN v_day_expired THEN 1 ELSE daily_requests_used + 1 END,
      day_reset_at = CASE WHEN v_day_expired THEN v_now ELSE day_reset_at END,
      period_requests_used = period_requests_used + 1,
      last_request_at = v_now,
      updated_at = v_now
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
      'allowed', true,
      'tier', v_row.tier
    );
  END IF;

  SELECT *
  INTO v_limits
  FROM public.usage_tier_limits
  WHERE tier = v_row.tier;
  v_has_limits := FOUND;

  v_period_used := v_row.period_requests_used;
  v_period_start := v_row.period_started_at;

  -- A month plan starts a new period after 30 days.
  IF v_row.access_source <> 'purchase' AND v_has_limits AND v_limits.period_kind = 'month' AND v_now - v_period_start > interval '30 days' THEN
    v_period_used := 0;
    v_period_start := v_now;
  END IF;

  -- A plan that renews by idleness (the free one): N calendar months after the last message the count
  -- and the money start again. A person with no message yet counts from the period start.
  IF v_has_limits AND v_row.first_real_purchase_at IS NULL
     AND v_limits.renew_after_idle_months IS NOT NULL
     AND v_now >= coalesce(v_row.last_request_at, v_row.period_started_at)
                  + make_interval(months => v_limits.renew_after_idle_months) THEN
    v_period_used := 0;
    v_period_start := v_now;
  END IF;

  IF v_has_limits THEN
    -- Serialize on usage (held above), then snapshot each pack's share in this accounting phase once.
    -- Do not drop already-funded spending merely because the pack's message balance became zero.
    UPDATE public.message_packs SET cost_budget_period_at=v_period_start,
      cost_budget_usd=CASE
        WHEN voided_at IS NOT NULL THEN 0
        WHEN purchased_at>=v_period_start THEN cost_allowance_usd
        WHEN expires_at>v_now THEN round(cost_allowance_usd*messages_left/messages_total,4)
        ELSE 0 END
      WHERE user_id=p_user_id AND cost_budget_period_at IS DISTINCT FROM v_period_start;
    -- The visible limit and the quiet ceiling (the money already spent on this person in the period).
    v_limit_hit := v_limits.period_request_limit IS NOT NULL AND v_period_used >= v_limits.period_request_limit;

    IF v_limits.cost_cap_usd IS NOT NULL THEN
      SELECT coalesce(sum(cost), 0)
      INTO v_spent
      FROM public.ai_usage_logs
      WHERE user_id = p_user_id
        AND created_at >= v_period_start;

      v_cap_hit := v_spent >= v_limits.cost_cap_usd;
    END IF;

    IF v_limit_hit OR v_cap_hit THEN
      -- The plan has nothing more to give, or the quiet ceiling is reached: only bought messages can go on.
      SELECT count(*) FILTER(WHERE voided_at IS NULL AND messages_left>0 AND expires_at>v_now),
        coalesce(sum(cost_budget_usd), 0)
      INTO v_open_packs, v_allowance
      FROM public.message_packs
      WHERE user_id = p_user_id AND cost_budget_period_at=v_period_start;

      IF v_open_packs = 0 THEN
        RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
          'allowed', false,
          'tier', v_row.tier,
          'reason', CASE WHEN v_limit_hit THEN 'period_limit' ELSE 'cost_cap' END
        );
      END IF;

      -- The bought messages raise the quiet ceiling by their allowance.
      IF v_limits.cost_cap_usd IS NOT NULL AND v_spent >= v_limits.cost_cap_usd + v_allowance THEN
        RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
          'allowed', false,
          'tier', v_row.tier,
          'reason', 'cost_cap'
        );
      END IF;

      -- A pack is spent only when the plan's own messages are out, the one that ends first goes first. With plan
      -- messages left (only the ceiling was reached) this message is a plan message and the pack stays whole.
      IF v_limit_hit THEN
        SELECT id
        INTO v_pack_id
        FROM public.message_packs
        WHERE user_id = p_user_id
          AND voided_at IS NULL
          AND messages_left > 0
          AND expires_at > v_now
        ORDER BY expires_at, purchased_at
        LIMIT 1
        FOR UPDATE;

        IF v_pack_id IS NULL THEN
          RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
            'allowed', false,
            'tier', v_row.tier,
            'reason', 'period_limit'
          );
        END IF;

        v_use_pack := true;
      END IF;
    END IF;
  END IF;

  IF NOT v_day_expired AND v_row.daily_requests_used >= v_row.daily_request_limit THEN
    RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
      'allowed', false,
      'tier', v_row.tier,
      'reason', 'daily_limit'
    );
  END IF;

  IF v_use_pack THEN
    UPDATE public.message_packs
    SET messages_left = messages_left - 1
    WHERE id = v_pack_id;
  END IF;

  -- Only here, for an allowed message, the clock of the last message moves. A message taken from a pack does not
  -- count against the plan's own messages.
  UPDATE public.user_usage_tiers
  SET
    daily_requests_used = CASE WHEN v_day_expired THEN 1 ELSE daily_requests_used + 1 END,
    day_reset_at = CASE WHEN v_day_expired THEN v_now ELSE day_reset_at END,
    period_requests_used = CASE WHEN v_use_pack THEN v_period_used ELSE v_period_used + 1 END,
    period_started_at = v_period_start,
    last_request_at = v_now,
    updated_at = v_now
  WHERE user_id = p_user_id;

  IF v_use_pack THEN
    RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
      'allowed', true,
      'tier', v_row.tier,
      'from_pack', true
    );
  END IF;

  RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
    'allowed', true,
    'tier', v_row.tier
  );
END;
$$;
CREATE OR REPLACE FUNCTION public.reserve_ai_request(p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=p_user_id FOR UPDATE;
 RETURN public.reserve_ai_request_at(p_user_id,clock_timestamp());
END;
$$;
CREATE OR REPLACE FUNCTION public._wipe_account_content(p_user_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Conversations first: everything with a conversation_id hangs on it and goes with it. The rest are the tables that only
  -- know the person (notes, derived logs). The memory goes through _wipe_memory.
  v_tables text[] := ARRAY[
    'conversations',
    'message_embeddings',
    'message_length_events',
    'message_model_summaries',
    'progress_entries',
    'protocol_events',
    'ai_reply_recovery_events',
    'message_feedback',
    'dynamics_feedback'
  ];
  v_table text;
  v_rows  bigint;
  v_total bigint := 0;
BEGIN
  PERFORM 1 FROM public.user_usage_tiers WHERE user_id=p_user_id FOR UPDATE;
  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I WHERE user_id = $1', v_table) USING p_user_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_total := v_total + v_rows;
    END IF;
  END LOOP;
  v_total := v_total + public._wipe_memory(p_user_id);
  RETURN v_total;
END;
$$;
CREATE FUNCTION public.save_my_conversation_summary(p_conversation_id uuid,p_summary text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=auth.uid() FOR UPDATE;
 IF NOT public.conversation_allowed_for(auth.uid(),p_conversation_id) OR NOT public.conversation_paid_features_for(auth.uid()) THEN RETURN false; END IF;
 IF length(p_summary)>200000 THEN RAISE EXCEPTION 'summary_too_long'; END IF;
 UPDATE public.conversations SET conversation_summary=p_summary WHERE id=p_conversation_id AND user_id=auth.uid();
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.conversation_allowed_at(uuid,uuid,timestamptz),
 public.expire_purchased_access_at(uuid,timestamptz),public.reserve_ai_request_at(uuid,timestamptz),
 public._wipe_account_content(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.save_my_conversation_summary(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_my_conversation_summary(uuid,text) TO authenticated;

