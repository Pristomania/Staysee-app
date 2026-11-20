/** Server-side feature tier only. Quota settlement is serialized separately in SQL.
 * Old rows without purchase metadata are legacy manual assignments, never implicit purchases.
 */
export function effectivePaidTier(row: {
  tier?: unknown;
  access_source?: unknown;
  paid_access_until?: unknown;
  unlimited_usage?: unknown;
  period_requests_used?: unknown;
}, serverNowMs = Date.now()): "free" | "basic" | "premium" {
  const tier = row.tier === "basic" || row.tier === "premium"
    ? row.tier
    : "free";
  if (row.unlimited_usage === true || row.access_source !== "purchase") {
    return tier;
  }
  const until = typeof row.paid_access_until === "string"
    ? Date.parse(row.paid_access_until)
    : NaN;
  return Number.isFinite(until) && until > serverNowMs ? tier : "free";
}
