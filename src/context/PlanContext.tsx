import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { fetchUsageRow } from '../lib/usageTier';
import { messageCounter, type MessageCounter, type UsageRow } from '../lib/messageCounter';
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
  /** Reads the plan and the counter again (after every answered message, and when the person comes back). */
  refresh: () => Promise<void>;
}

const PlanContext = createContext<PlanContextType | null>(null);

export function PlanProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const [row, setRow] = useState<UsageRow | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) {
      setRow(null);
      return;
    }
    // A missing row means the plan is not known, not that it is free: the app stays unlocked and the server decides.
    setRow(await fetchUsageRow(userId));
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<PlanContextType>(() => {
    const loaded = row !== null;
    const tier = normalizePlanId(row?.tier);
    return {
      tier,
      plan: planFor(tier),
      loaded,
      has: (feature) => !loaded || isFeatureAvailable(tier, feature),
      counter: messageCounter(row),
      refresh,
    };
  }, [row, refresh]);

  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlan(): PlanContextType {
  const context = useContext(PlanContext);
  if (!context) throw new Error('usePlan must be used inside PlanProvider');
  return context;
}
