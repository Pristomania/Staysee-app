export type QuotaDenyHttp = {
  status: number;
  body: Record<string, unknown>;
};

export function mapQuotaDenyResponse(
  reason: string | undefined,
  calm: { suspended: string; rateLimit: string; freeUsedUp: string; monthUsedUp: string },
  tier?: string,
): QuotaDenyHttp {
  if (reason === "suspended") {
    return { status: 429, body: { content: calm.suspended } };
  }
  if (reason === "daily_limit") {
    return { status: 429, body: { content: calm.rateLimit } };
  }
  // The message limit and the hidden spending ceiling read the same to the person: only the plan decides the text.
  if (reason === "period_limit" || reason === "cost_cap") {
    return { status: 429, body: { content: tier === "free" ? calm.freeUsedUp : calm.monthUsedUp } };
  }
  return { status: 503, body: { error: "service_unavailable" } };
}
