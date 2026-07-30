export type QuotaDenyHttp = {
  status: number;
  body: Record<string, unknown>;
};

export function mapQuotaDenyResponse(
  reason: string | undefined,
  calm: { suspended: string; rateLimit: string },
): QuotaDenyHttp {
  if (reason === "suspended") {
    return { status: 429, body: { content: calm.suspended } };
  }
  if (reason === "daily_limit") {
    return { status: 429, body: { content: calm.rateLimit } };
  }
  return { status: 503, body: { error: "service_unavailable" } };
}
