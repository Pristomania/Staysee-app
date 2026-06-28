/**
 * Shared conversation_summary refresh (sync eager + background async).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  buildConversationSummary,
  finalizeMemoryUpdate,
  getConversationSummary,
  structuredMemoryHasContent,
  updateConversationSummary,
  type StructuredMemory,
} from "./memory.ts";
import {
  loadActiveCorrections,
  memoryCorrectionsEnabled,
  mergeDurableCorrections,
} from "./memoryCorrections.ts";
import type { DurableMemoryCorrection } from "./memoryCorrectionApply.ts";
import {
  logSummaryGenerationUsage,
  type OpenRouterUsagePayload,
} from "./usageAnalytics.ts";
import { refreshUserLifeMemory, type LifeMemoryModelConfig } from "./userLifeMemory.ts";

export interface SummaryRefreshRunInput {
  supabase: SupabaseClient;
  conversationId: string;
  userId: string | null;
  previousSummary: string | null;
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  memoryHints: string[];
  model: LifeMemoryModelConfig;
  /** Same-turn corrections not yet visible to loadActiveCorrections. */
  extraDurableCorrections?: DurableMemoryCorrection[];
}

export async function runConversationSummaryRefresh(
  input: SummaryRefreshRunInput
): Promise<StructuredMemory | null> {
  const apiKey = input.model.apiKey;
  if (!apiKey) return null;

  let durableCorrections: DurableMemoryCorrection[] = [];
  if (memoryCorrectionsEnabled() && input.userId) {
    const loaded = await loadActiveCorrections(
      input.supabase,
      input.userId,
      input.conversationId
    );
    durableCorrections = mergeDurableCorrections(
      loaded,
      input.extraDurableCorrections ?? []
    );
  } else if (input.extraDurableCorrections?.length) {
    durableCorrections = input.extraDurableCorrections;
  }

  const summaryPrompt = buildConversationSummary({
    conversationId: input.conversationId,
    previousSummary: input.previousSummary,
    transcript: input.transcript,
    corrections: input.memoryHints,
    durableCorrections,
  });

  const res = await fetch(`${input.model.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(input.model.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: input.model.model,
      messages: [{ role: "user", content: summaryPrompt }],
      max_tokens: 700,
      temperature: 0.25,
      usage: { include: true },
    }),
  });

  if (!res.ok) {
    console.warn("[summaryRefresh] model failed:", res.status);
    return null;
  }

  const data = await res.json();
  const modelOut: string = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!modelOut) return null;

  if (input.userId) {
    await logSummaryGenerationUsage(input.supabase, {
      userId: input.userId,
      conversationId: input.conversationId,
      model: input.model.model,
      summaryPrompt,
      modelOutput: modelOut,
      usage: data.usage as OpenRouterUsagePayload | undefined,
    });
  }

  try {
    const { memory, compressed } = finalizeMemoryUpdate(
      input.previousSummary,
      modelOut,
      input.memoryHints,
      durableCorrections
    );
    if (!structuredMemoryHasContent(memory) && !durableCorrections.length) {
      console.warn(
        `[summaryRefresh] skip empty memory conversation=${input.conversationId}`
      );
      return null;
    }

    await updateConversationSummary({
      supabase: input.supabase,
      conversationId: input.conversationId,
      memory,
      allowEmptyMemory: durableCorrections.length > 0,
    });

    if (input.userId) {
      await refreshUserLifeMemory(
        input.supabase,
        input.userId,
        memory,
        input.model,
        input.memoryHints,
        input.conversationId,
        durableCorrections
      );
    }

    console.log(
      `[summaryRefresh] updated conversation=${input.conversationId} compressed=${compressed}`
    );
    return memory;
  } catch (e) {
    console.error("[summaryRefresh] parse failed:", e);
    return null;
  }
}
