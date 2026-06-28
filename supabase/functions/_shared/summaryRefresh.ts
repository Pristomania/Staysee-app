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
import {
  memoryDiagSummaryBuild,
  memoryDiagSummarySave,
} from "./memoryDiag.ts";

export interface MemoryDiagContext {
  enabled: boolean;
  conversationId: string;
}

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
  diag?: MemoryDiagContext;
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
    memoryDiagSummaryBuild({
      enabled: !!input.diag?.enabled,
      attempted: true,
      sourceMessageCount: input.transcript.length,
      userTurnCount: input.transcript.filter((m) => m.role === "user").length,
      modelFailed: true,
    });
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
      memoryDiagSummaryBuild({
        enabled: !!input.diag?.enabled,
        attempted: true,
        sourceMessageCount: input.transcript.length,
        userTurnCount: input.transcript.filter((m) => m.role === "user").length,
        resultBytes: 0,
        memory: null,
      });
      return null;
    }

    memoryDiagSummaryBuild({
      enabled: !!input.diag?.enabled,
      attempted: true,
      sourceMessageCount: input.transcript.length,
      userTurnCount: input.transcript.filter((m) => m.role === "user").length,
      resultBytes: JSON.stringify(memory).length,
      memory,
    });

    const saveResult = await updateConversationSummary({
      supabase: input.supabase,
      conversationId: input.conversationId,
      memory,
      allowEmptyMemory: durableCorrections.length > 0,
    });

    let postSummaryBytes = 0;
    let postSummaryUpdatedAt: string | null = null;
    if (input.diag?.enabled) {
      const { data: postRow } = await input.supabase
        .from("conversations")
        .select("conversation_summary, summary, summary_updated_at")
        .eq("id", input.conversationId)
        .maybeSingle();
      const postSummary = getConversationSummary(postRow ?? null);
      postSummaryBytes = postSummary?.length ?? 0;
      postSummaryUpdatedAt = (postRow?.summary_updated_at as string) ?? null;
    }

    memoryDiagSummarySave({
      enabled: !!input.diag?.enabled,
      attempted: true,
      success: saveResult.ok,
      errorCode: saveResult.errorCode ?? null,
      errorMessage: saveResult.errorMessage ?? null,
      postSaveSummaryBytes: postSummaryBytes,
      postSaveSummaryUpdatedAt: postSummaryUpdatedAt,
    });

    if (input.userId) {
      await refreshUserLifeMemory(
        input.supabase,
        input.userId,
        memory,
        input.model,
        input.memoryHints,
        input.conversationId,
        durableCorrections,
        input.diag
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
