import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { fetchPackRows, fetchUsageRow } from '../lib/usageTier';
import { messageCounter, type MessageCounter, type PackRow, type UsageRow } from '../lib/messageCounter';
import { getMaxRooms } from '../lib/roomLimits';
import { isFeatureAvailable, normalizePlanId, planFor, type Plan, type PlanFeature, type PlanId } from '../lib/plans';

interface PlanContextType {
  /** The plan of the person; "free" until it is known and for anyone not signed in. */
  tier: PlanId;
  plan: Plan;
  /** False until the plan has been read. While false the app does not lock anything: the server decides. */
  loaded: boolean;
  /** True when the plan includes the feature; also true while the plan is not known yet (see `loaded`). */
  has: (feature: PlanFeature) => boolean;
  /** The messages left, worked out from the person's usage row; null while it is not known. */
  counter: MessageCounter | null;
  /** How many conversations the person may have: the plan's number, or the one given by hand. */
  maxConversations: number;
  /** Reads the plan and the counter again (after every answered message, and when the person comes back). */
  refresh: () => Promise<void>;
}

const PlanContext = createContext<PlanContextType | null>(null);

export function PlanProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const [row, setRow] = useState<UsageRow | null>(null);
  const [packs, setPacks] = useState<PackRow[]>([]);
  const currentUserRef = useRef(userId);

  useEffect(() => {
    currentUserRef.current = userId;
  }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId) {
      setRow(null);
      return;
    }
    const [next, nextPacks] = await Promise.all([fetchUsageRow(userId), fetchPackRows(userId)]);
    // Somebody else signed in while this was being read: their plan is not this answer.
    if (currentUserRef.current !== userId) return;
    // A failed read must not wipe what is known: a network blip would unlock everything and hide the counter until the
    // next read. Only a successful read replaces the row (and the same for the bought messages).
    if (next) setRow(next);
    if (nextPacks) setPacks(nextPacks);
  }, [userId]);

  useEffect(() => {
    // Another person (or nobody): forget the previous person's row before reading.
    setRow(null);
    setPacks([]);
    void refresh();
  }, [refresh]);

  // The plan and the counter change outside this tab too (another tab, a renewed period): read them again when the
  // person comes back to this one.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const value = useMemo<PlanContextType>(() => {
    const loaded = row !== null;
    const tier = normalizePlanId(row?.tier);
    return {
      tier,
      plan: planFor(tier),
      loaded,
      has: (feature) => !loaded || isFeatureAvailable(tier, feature),
      counter: messageCounter(row, new Date(), packs),
      maxConversations: getMaxRooms(tier, row?.max_conversations_override),
      refresh,
    };
  }, [row, packs, refresh]);

  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlan(): PlanContextType {
  const context = useContext(PlanContext);
  if (!context) throw new Error('usePlan must be used inside PlanProvider');
  return context;
}
