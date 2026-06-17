/**
 * Structured model call abstraction — PR3b-2 foundation only.
 * Not invoked from staysee-chat until PR3b-3+.
 * Mirrors plain callModel with response_format json_schema.
 */

import { estimateTokens } from "./cost.ts";
import { parseOpenRouterUsage } from "./usageAnalytics.ts";
import { buildStructuredTurnJsonSchema } from "./structuredTurnSchema.ts";

export interface StructuredModelProviderConfig {
  baseUrl: string;
  model: string;
  envKey: string;
  extraHeaders?: Record<string, string>;
}

export interface StructuredModelCallInput {
  primaryProvider: string;
  primaryConfig: StructuredModelProviderConfig;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  modelOverride?: string;
}

export interface StructuredModelCallResult {
  rawContent: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  finishReason?: string;
  usage?: { cost?: number; total_tokens?: number };
}

/**
 * OpenRouter chat completion with strict structured turn JSON schema.
 * Caller must parse via parseStructuredTurn() and handle fallback to plain pipeline.
 */
export async function callModelStructured(
  input: StructuredModelCallInput
): Promise<StructuredModelCallResult | null> {
  const apiKey = Deno.env.get(input.primaryConfig.envKey);
  if (!apiKey) {
    console.warn(
      `[structured-model] no key for ${input.primaryProvider} (env: ${input.primaryConfig.envKey})`
    );
    return null;
  }

  const model = input.modelOverride ?? input.primaryConfig.model;
  const jsonSchema = buildStructuredTurnJsonSchema();

  console.log(
    `[structured-model] calling ${input.primaryProvider} model=${model} maxTokens=${input.maxTokens} structured=true`
  );

  let res: Response;
  try {
    res = await fetch(`${input.primaryConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(input.primaryConfig.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: input.systemPrompt },
          ...input.messages,
        ],
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        usage: { include: true },
        response_format: {
          type: "json_schema",
          json_schema: jsonSchema,
        },
      }),
    });
  } catch (fetchErr) {
    console.error(`[structured-model] fetch error ${input.primaryProvider}:`, fetchErr);
    return null;
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(
      `[structured-model] ${input.primaryProvider} HTTP ${res.status}: ${errBody.slice(0, 300)}`
    );
    return null;
  }

  const data = await res.json();
  const rawContent: string = data.choices?.[0]?.message?.content ?? "";
  const finishReason: string | undefined = data.choices?.[0]?.finish_reason;

  if (!rawContent) {
    console.error(
      `[structured-model] ${input.primaryProvider} empty content, raw:`,
      JSON.stringify(data).slice(0, 200)
    );
    return null;
  }

  const parsed = parseOpenRouterUsage(data);
  console.log(
    `[structured-model] ${input.primaryProvider} ok, tokens: ${parsed.totalTokens}` +
      (parsed.cost !== undefined ? ` cost=$${parsed.cost}` : "")
  );

  return {
    rawContent,
    provider: input.primaryProvider,
    model,
    promptTokens:
      parsed.promptTokens ||
      estimateTokens(
        input.systemPrompt + input.messages.map((m) => m.content).join(" ")
      ),
    completionTokens: parsed.completionTokens || estimateTokens(rawContent),
    finishReason,
    usage: { cost: parsed.cost, total_tokens: parsed.totalTokens },
  };
}
