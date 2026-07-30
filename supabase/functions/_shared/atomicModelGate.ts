import type { RateLimitResult } from "./cost.ts";

export type AtomicModelGateResult<T> =
  | { ok: true; value: T; reserve: RateLimitResult }
  | { ok: false; reserve: RateLimitResult };

export async function runAtomicModelGate<T>(opts: {
  reserve: () => Promise<RateLimitResult>;
  callModel: () => Promise<T>;
}): Promise<AtomicModelGateResult<T>> {
  const reserve = await opts.reserve();
  if (!reserve.allowed) {
    return { ok: false, reserve };
  }
  const value = await opts.callModel();
  return { ok: true, value, reserve };
}
