/**
 * The private route, for every request that carries what a person wrote or attached. OpenRouter then sends the
 * request only to endpoints that keep nothing (zero data retention) and do not train on it, and fails the request
 * rather than send it anywhere else. A failed reply falls back to the other approved model, which has such endpoints
 * too (GPT-4o: Azure; Sonnet: Amazon Bedrock and Google Vertex).
 *
 * Measured live on 31.10 against the default route: the same price per token and the same answers; the default route
 * had sent some GPT-4o requests to OpenAI itself. openRouterPrivateRoute.cases.test.ts fails when a file that calls a
 * model does not carry it.
 */
export const OPENROUTER_PRIVATE_ROUTE = { data_collection: "deny", zdr: true } as const;
