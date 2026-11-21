-- 109: Adjacent ordering is server-owned. Do not rewrite message/activity timestamps.
ALTER TABLE public.user_usage_tiers ADD COLUMN conversation_order uuid[] NOT NULL DEFAULT '{}';

CREATE FUNCTION public.normalized_conversation_order(p_user uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(array_agg(c.id ORDER BY array_position(u.conversation_order,c.id) NULLS LAST,
  greatest(c.last_message_at,coalesce(c.manual_sort_at,c.last_message_at)) DESC NULLS LAST,
  c.created_at DESC NULLS LAST,c.id DESC),'{}'::uuid[])
 FROM public.conversations c JOIN public.user_usage_tiers u ON u.user_id=c.user_id
 WHERE c.user_id=p_user AND c.is_active IS TRUE;
$$;
UPDATE public.user_usage_tiers SET conversation_order=public.normalized_conversation_order(user_id);

CREATE OR REPLACE FUNCTION public.refresh_conversation_anchor(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_order uuid[];
BEGIN
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=p_user FOR UPDATE;
 IF NOT FOUND OR NOT public.conversation_full_access_for(p_user) THEN RETURN; END IF;
 v_order:=public.normalized_conversation_order(p_user);
 UPDATE public.user_usage_tiers SET free_conversation_id=v_order[1] WHERE user_id=p_user;
END;
$$;

CREATE FUNCTION public.conversation_order_after_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_user uuid; v_order uuid[];
BEGIN
 v_user:=CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=v_user FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 v_order:=public.normalized_conversation_order(v_user);
 IF TG_OP<>'DELETE' AND NEW.is_active IS TRUE THEN
  IF TG_OP='INSERT' THEN
   v_order:=ARRAY[NEW.id]||array_remove(v_order,NEW.id);
  ELSIF OLD.is_active IS DISTINCT FROM NEW.is_active
    OR OLD.last_message_at IS DISTINCT FROM NEW.last_message_at
    OR OLD.manual_sort_at IS DISTINCT FROM NEW.manual_sort_at THEN
   v_order:=ARRAY[NEW.id]||array_remove(v_order,NEW.id);
  END IF;
 END IF;
 UPDATE public.user_usage_tiers SET conversation_order=v_order WHERE user_id=v_user;
 RETURN NULL;
END;
$$;
-- PostgreSQL fires same-kind triggers alphabetically: update order BEFORE anchor.
CREATE TRIGGER conversation_00_order_after_change AFTER INSERT OR DELETE OR UPDATE OF last_message_at,manual_sort_at,is_active
 ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.conversation_order_after_change();

CREATE FUNCTION public.move_my_conversation_step(p_conversation_id uuid,p_direction text,p_expected_neighbor uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_user uuid:=auth.uid(); v_order uuid[]; v_index integer; v_neighbor integer;
BEGIN
 IF p_direction IS NULL OR p_direction NOT IN ('up','down') THEN RAISE EXCEPTION 'invalid_direction'; END IF;
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=v_user FOR UPDATE;
 IF NOT FOUND OR NOT public.conversation_paid_features_for(v_user) OR NOT EXISTS(
  SELECT 1 FROM public.conversations WHERE id=p_conversation_id AND user_id=v_user AND is_active IS TRUE)
 THEN RAISE EXCEPTION 'conversation_locked'; END IF;
 v_order:=public.normalized_conversation_order(v_user);
 v_index:=array_position(v_order,p_conversation_id);
 v_neighbor:=v_index+CASE WHEN p_direction='up' THEN -1 ELSE 1 END;
 IF p_expected_neighbor IS NULL OR v_neighbor<1 OR v_neighbor>cardinality(v_order)
  OR v_order[v_neighbor] IS DISTINCT FROM p_expected_neighbor THEN RAISE EXCEPTION 'conversation_order_changed'; END IF;
 v_order[v_index]:=p_expected_neighbor; v_order[v_neighbor]:=p_conversation_id;
 -- Authorization happened under this lock. Persist the corresponding anchor in
 -- the SAME write: a deadline between this write and a second rights check must
 -- not freeze the previous top while accepting the new order.
 UPDATE public.user_usage_tiers SET conversation_order=v_order,free_conversation_id=v_order[1] WHERE user_id=v_user;
 RETURN true;
END;
$$;

-- Older app builds retain their move-top RPC, but a reading-only override is
-- not permission to reorder (nor to choose another free archive anchor).
CREATE OR REPLACE FUNCTION public.move_my_conversation_to_top(p_conversation_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count integer;
BEGIN
 PERFORM 1 FROM public.user_usage_tiers WHERE user_id=auth.uid() FOR UPDATE;
 IF NOT FOUND OR NOT public.conversation_paid_features_for(auth.uid()) THEN RAISE EXCEPTION 'conversation_locked'; END IF;
 UPDATE public.conversations SET manual_sort_at=clock_timestamp()
 WHERE id=p_conversation_id AND user_id=auth.uid() AND is_active IS TRUE;
 GET DIAGNOSTICS v_count=ROW_COUNT; RETURN v_count=1;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_my_conversations() RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'user_id',c.user_id,'title',coalesce(c.title,''),
 'is_active',c.is_active,'created_at',coalesce(c.created_at,c.last_message_at,'epoch'::timestamptz),
 'last_message_at',coalesce(c.last_message_at,c.created_at,'epoch'::timestamptz),
 'can_read',public.conversation_allowed_for(auth.uid(),c.id)) ORDER BY o.position),'[]'::jsonb)
 FROM unnest(public.normalized_conversation_order(auth.uid())) WITH ORDINALITY AS o(id,position)
 JOIN public.conversations c ON c.id=o.id JOIN public.profiles p ON p.id=c.user_id
 WHERE c.user_id=auth.uid() AND c.is_active IS TRUE AND p.room_deletion_requested_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public.normalized_conversation_order(uuid),public.conversation_order_after_change()
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.move_my_conversation_step(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.move_my_conversation_step(uuid,text,uuid) TO authenticated;
-- Existing table RLS/column grants remain unchanged; no client can write usage/order.
