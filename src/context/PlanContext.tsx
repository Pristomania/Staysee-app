import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { fetchUsageTier } from '../lib/usageTier';
import { isFeatureAvailable, normalizePlanId, planFor, type Plan, type PlanFeature, type PlanId } from '../lib/plans';

interface PlanContextType {
  /** The plan of the person; "free" until it is known and for anyone not signed in. */
  tier: PlanId;
  plan: Plan;
  /** False until the plan has been read. While false the app does not lock anything: the server decides. */
  loaded: boolean;
  /** True when the plan includes the feature; also true while the plan is not known yet (see `loaded`). */
  has: (feature: PlanFeature) => boolean;
  refresh: () => Promise<void>;
}

const PlanContext = createContext<PlanContextType | null>(null);

export function PlanProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const [tier, setTier] = useState<PlanId>('free');
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) {
      setTier('free');
      setLoaded(false);
      return;
    }
    const { row } = await fetchUsageTier(userId);
    // A missing row means the plan is not known, not that it is free: leave the app unlocked and let the server decide.
    setTier(normalizePlanId(row?.tier));
    setLoaded(row !== null);
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<PlanContextType>(
    () => ({
      tier,
      plan: planFor(tier),
      loaded,
      has: (feature) => !loaded || isFeatureAvailable(tier, feature),
      refresh,
    }),
    [tier, loaded, refresh],
  );

  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlan(): PlanContextType {
  const context = useContext(PlanContext);
  if (!context) throw new Error('usePlan must be used inside PlanProvider');
  return context;
}
