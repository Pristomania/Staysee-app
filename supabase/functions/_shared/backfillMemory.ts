/**
 * StaySee — Backfill conversation_summary for existing conversations.
 * Condensed multi-pass summarization for long threads (avoids giant prompts).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { normalizeMessageRole } from "./messageRole.ts";
import {
  buildConversationSummary,
  evaluateSummarySaveCandidate,
  finalizeMemoryUpdate,
  getConversationSummary,
  isTrivialEmptySummary,
  MEMORY_SAFE_RULES,
  serializeMemory,
  structuredMemoryFieldCounts,
  structuredMemoryHasContent,
  type SummaryBuildInput,
} from "./memory.ts";
import { estimateTokens } from "./cost.ts";

export const BACKFILL_CONVERSATIONS_PER_RUN = 8;
export const BACKFILL_MIN_MESSAGES = 4;
/** Messages per chunk when condensing long histories. */
export const BACKFILL_CHUNK_SIZE = 22;
/** Max chunk passes before merge (caps cost on 300+ message threads). */
export const BACKFILL_MAX_CHUNKS = 8;
/** Single-pass threshold — short threads fit in one prompt. */
export const BACKFILL_SINGLE_PASS_MAX = 36;

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

export interface BackfillChunkPlan {
  offset: number;
  limit: number;
  label: string;
}

export interface BackfillConversationRow {
  id: string;
  title: string | null;
  conversation_summary: string | null;
  summary: string | null;
}

export interface BackfillOptions {
  /** Ignore needsSummaryBackfill and BACKFILL_MIN_MESSAGES skip rules. */
  force?: boolean;
}

export interface BackfillDiagnostics {
  messageCount: number;
  chunkPlans: number;
  chunksModelReturned: number;
  chunksNonEmpty: number;
  chunksEmptySkipped: number;
  mergeUsed: boolean;
  model: string;
  fieldCounts: Record<string, number>;
  previousNonEmpty: boolean;
  candidateEmpty: boolean;
  allowEmptyMemory: boolean;
  saveReason?: string;
}

export interface BackfillResult {
  conversationId: string;
  status: "ok" | "skipped" | "failed";
  messageCount?: number;
  messagesFound?: number;
  summaryGenerated?: boolean;
  saved?: boolean;
  skipped?: boolean;
  forced?: boolean;
  chunks?: number;
  reason?: string;
  error?: string;
  diagnostics?: BackfillDiagnostics;
}

/** Plan which message windows to load (condensed, not full transcript). */
export function planBackfillChunks(totalMessages: number): BackfillChunkPlan[] {
  if (totalMessages <= 0) return [];
  if (totalMessages <= BACKFILL_SINGLE_PASS_MAX) {
    return [{ offset: 0, limit: totalMessages, label: "полная беседа" }];
  }

  const plans: BackfillChunkPlan[] = [];
  const openSize = Math.min(14, totalMessages);
  plans.push({ offset: 0, limit: openSize, label: "начало беседы" });

  const tailSize = Math.min(20, totalMessages - openSize);
  const tailOffset = Math.max(openSize, totalMessages - tailSize);

  if (totalMessages <= BACKFILL_CHUNK_SIZE * BACKFILL_MAX_CHUNKS) {
    let offset = openSize;
    let midIndex = 1;
    while (offset < tailOffset && plans.length < BACKFILL_MAX_CHUNKS - 1) {
      const limit = Math.min(BACKFILL_CHUNK_SIZE, tailOffset - offset);
      if (limit < BACKFILL_MIN_MESSAGES) break;
      plans.push({
        offset,
        limit,
        label: `середина ${midIndex}`,
      });
      offset += limit;
      midIndex++;
    }
  } else {
    const midStarts = [
      Math.floor(totalMessages * 0.28),
      Math.floor(totalMessages * 0.5),
      Math.floor(totalMessages * 0.72),
    ];
    const window = 10;
    for (let i = 0; i < midStarts.length && plans.length < BACKFILL_MAX_CHUNKS - 1; i++) {
      const start = Math.max(openSize, midStarts[i] - Math.floor(window / 2));
      const limit = Math.min(window, tailOffset - start);
      if (limit >= 4) {
        plans.push({ offset: start, limit, label: `фрагмент ${i + 1}` });
      }
    }
  }

  if (tailOffset > openSize && plans.length < BACKFILL_MAX_CHUNKS) {
    plans.push({ offset: tailOffset, limit: tailSize, label: "недавняя часть" });
  }

  return plans.slice(0, BACKFILL_MAX_CHUNKS);
}

export async function countConversationMessages(
  supabase: SupabaseClient,
  conversationId: string
): Promise<number> {
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId);
  if (error) {
    console.error("[backfill] countMessages:", error.message);
    return 0;
  }
  return count ?? 0;
}

export async function fetchMessageSlice(
  supabase: SupabaseClient,
  conversationId: string,
  offset: number,
  limit: number
): Promise<TranscriptMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("sender, role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error || !data) {
    console.error("[backfill] fetchMessageSlice:", error?.message);
    return [];
  }

  return data.map((m) => ({
    role: normalizeMessageRole(m),
    content: m.content ?? "",
  }));
}

function formatTranscript(messages: TranscriptMessage[]): string {
  return messages
    .filter((m) => m.content.trim())
    .map((m) => `${m.role === "user" ? "Пользователь" : "StaySee"}: ${m.content}`)
    .join("\n");
}

/** Short pass for one chunk — keeps prompts small. */
const CHUNK_JSON_SCHEMA = `{
  "people": ["имя или роль"],
  "themes": ["повторяющаяся тема"],
  "emotional_state": ["как переживает"],
  "important_events": ["факт от пользователя"],
  "preferences": ["стиль общения"],
  "risks": [],
  "open_loops": ["нерешённое"],
  "last_updated": ""
}`;

export function buildChunkSummaryPrompt(
  messages: TranscriptMessage[],
  chunkLabel: string
): string {
  const transcript = formatTranscript(messages);
  return `${MEMORY_SAFE_RULES}

Сожми фрагмент (${chunkLabel}). Верни ТОЛЬКО JSON по схеме — заполни поля фактами из фрагмента; не возвращай все массивы пустыми:
${CHUNK_JSON_SCHEMA}

Фрагмент:
${transcript}

Только факты пользователя. Без поэзии.`.trim();
}

/** Merge chunk notes into final conversation_summary. */
export function buildBackfillMergePrompt(
  chunkSummaries: string[],
  title?: string | null
): string {
  const joined = chunkSummaries.map((s, i) => `[${i + 1}]\n${s}`).join("\n\n");
  const titleLine = title?.trim() ? `Тема беседы: ${title.trim()}\n\n` : "";

  return `${MEMORY_SAFE_RULES}
${titleLine}Фрагменты памяти (JSON или текст):
${joined}

Объедини в один JSON (только JSON, без markdown) по схеме:
${CHUNK_JSON_SCHEMA}

Убери дубликаты. Сохрани устойчивые темы. Убери шум.
Запрещено возвращать пустые массивы во всех полях, если во фрагментах выше есть факты — перенеси их.`.trim();
}

/** Chunk model output with no extractable facts (empty JSON shell). */
export function chunkSummaryHasContent(text: string): boolean {
  return !isTrivialEmptySummary(text);
}

export function logBackfillDiagnostics(
  conversationId: string,
  diagnostics: BackfillDiagnostics
): void {
  console.log(
    `[backfill] diagnostics ${conversationId}`,
    JSON.stringify(diagnostics)
  );
}

export interface SummaryModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
}

export async function callSummaryModel(
  config: SummaryModelConfig,
  prompt: string,
  maxTokens: number
): Promise<string | null> {
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...(config.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.25,
      }),
    });
    if (!res.ok) {
      console.error("[backfill] model HTTP", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content?.trim() ?? "";
    return text || null;
  } catch (e) {
    console.error("[backfill] model error:", e);
    return null;
  }
}

/** True when conversation_summary is empty (re-build from messages even if legacy summary exists). */
export function needsSummaryBackfill(row: BackfillConversationRow): boolean {
  const raw = row.conversation_summary?.trim();
  if (!raw) return true;
  return isTrivialEmptySummary(raw);
}

export async function fetchConversationById(
  supabase: SupabaseClient,
  conversationId: string
): Promise<BackfillConversationRow | null> {
  const id = conversationId.trim();
  let { data, error } = await supabase
    .from("conversations")
    .select("id, title, conversation_summary, summary")
    .eq("id", id)
    .maybeSingle();

  if (error?.message?.includes("deleted_at")) {
    const retry = await supabase
      .from("conversations")
      .select("id, title, conversation_summary, summary")
      .eq("id", id)
      .maybeSingle();
    data = retry.data;
    error = retry.error;
  }

  if (error) {
    console.error("[backfill] fetchConversationById:", error.message);
    return null;
  }
  return (data as BackfillConversationRow) ?? null;
}

/** Generate and persist conversation_summary for one conversation. */
export async function backfillOneConversation(
  supabase: SupabaseClient,
  model: SummaryModelConfig,
  conversation: BackfillConversationRow,
  options?: BackfillOptions
): Promise<BackfillResult> {
  const id = conversation.id;
  const forced = options?.force === true;

  try {
    const messageCount = await countConversationMessages(supabase, id);
    const messagesFound = messageCount;

    if (messageCount === 0) {
      return {
        conversationId: id,
        status: "failed",
        messageCount: 0,
        messagesFound: 0,
        summaryGenerated: false,
        saved: false,
        forced,
        error: "no_messages",
      };
    }

    if (!forced && messageCount < BACKFILL_MIN_MESSAGES) {
      return {
        conversationId: id,
        status: "skipped",
        messageCount,
        messagesFound,
        summaryGenerated: false,
        saved: false,
        forced,
        error: `min_messages_${BACKFILL_MIN_MESSAGES}`,
      };
    }

    const plans = planBackfillChunks(messageCount);
    const chunkSummaries: string[] = [];
    let chunksModelReturned = 0;
    let chunksEmptySkipped = 0;
    const previousSummary = getConversationSummary(conversation);
    const previousNonEmpty =
      !!previousSummary?.trim() && !isTrivialEmptySummary(previousSummary);

    for (const plan of plans) {
      const slice = await fetchMessageSlice(supabase, id, plan.offset, plan.limit);
      if (slice.length === 0) continue;

      const tokenEst = estimateTokens(formatTranscript(slice));
      if (tokenEst > 12_000) {
        console.warn(`[backfill] chunk too large ${id} ${plan.label}, truncating`);
        slice.splice(Math.floor(slice.length / 2));
      }

      let prompt: string;
      let maxTokens: number;

      if (plans.length === 1) {
        const input: SummaryBuildInput = {
          conversationId: id,
          previousSummary,
          transcript: slice,
        };
        prompt = buildConversationSummary(input);
        maxTokens = 500;
      } else {
        prompt = buildChunkSummaryPrompt(slice, plan.label);
        maxTokens = 280;
      }

      const part = await callSummaryModel(model, prompt, maxTokens);
      if (!part) continue;
      chunksModelReturned++;
      if (chunkSummaryHasContent(part)) {
        chunkSummaries.push(part);
      } else {
        chunksEmptySkipped++;
        console.warn(
          `[backfill] skip empty chunk ${id} label=${plan.label} bytes=${part.length}`
        );
      }
    }

    if (chunkSummaries.length === 0) {
      const reason = previousNonEmpty
        ? "empty_summary_guard"
        : "empty_chunk_summaries";
      const diagnostics: BackfillDiagnostics = {
        messageCount,
        chunkPlans: plans.length,
        chunksModelReturned,
        chunksNonEmpty: 0,
        chunksEmptySkipped,
        mergeUsed: false,
        model: model.model,
        fieldCounts: {},
        previousNonEmpty,
        candidateEmpty: true,
        allowEmptyMemory: false,
        saveReason: reason,
      };
      logBackfillDiagnostics(id, diagnostics);
      return {
        conversationId: id,
        status: previousNonEmpty ? "skipped" : "failed",
        messageCount,
        messagesFound,
        summaryGenerated: chunksModelReturned > 0,
        saved: false,
        skipped: previousNonEmpty,
        forced,
        reason,
        error: reason,
        diagnostics,
      };
    }

    const mergeUsed = chunkSummaries.length > 1;
    let modelOut: string | null;
    if (chunkSummaries.length === 1) {
      modelOut = chunkSummaries[0];
    } else {
      const mergePrompt = buildBackfillMergePrompt(
        chunkSummaries,
        conversation.title
      );
      modelOut = await callSummaryModel(model, mergePrompt, 700);
    }

    const summaryGenerated = !!modelOut?.trim();
    if (!summaryGenerated) {
      const diagnostics: BackfillDiagnostics = {
        messageCount,
        chunkPlans: plans.length,
        chunksModelReturned,
        chunksNonEmpty: chunkSummaries.length,
        chunksEmptySkipped,
        mergeUsed,
        model: model.model,
        fieldCounts: {},
        previousNonEmpty,
        candidateEmpty: true,
        allowEmptyMemory: false,
        saveReason: "merge_failed",
      };
      logBackfillDiagnostics(id, diagnostics);
      return {
        conversationId: id,
        status: "failed",
        messageCount,
        messagesFound,
        summaryGenerated: false,
        saved: false,
        skipped: false,
        forced,
        chunks: chunkSummaries.length,
        reason: "merge_failed",
        error: "merge_failed",
        diagnostics,
      };
    }

    const { memory, compressed } = finalizeMemoryUpdate(
      forced ? null : previousSummary,
      modelOut!
    );
    const candidateEmpty = !structuredMemoryHasContent(memory);
    const saveDecision = evaluateSummarySaveCandidate({
      previousRaw: previousSummary,
      candidate: memory,
      allowEmptyMemory: false,
    });
    const diagnostics: BackfillDiagnostics = {
      messageCount,
      chunkPlans: plans.length,
      chunksModelReturned,
      chunksNonEmpty: chunkSummaries.length,
      chunksEmptySkipped,
      mergeUsed,
      model: model.model,
      fieldCounts: structuredMemoryFieldCounts(memory),
      previousNonEmpty,
      candidateEmpty,
      allowEmptyMemory: false,
      saveReason: saveDecision.reason,
    };
    logBackfillDiagnostics(id, diagnostics);

    if (!saveDecision.allowed) {
      console.warn(
        `[backfill] ${forced ? "forced " : ""}skip save ${id} reason=${saveDecision.reason} previousNonEmpty=${previousNonEmpty} candidateEmpty=${candidateEmpty}`
      );
      return {
        conversationId: id,
        status: "skipped",
        messageCount,
        messagesFound,
        summaryGenerated: true,
        saved: false,
        skipped: true,
        forced,
        chunks: chunkSummaries.length,
        reason: saveDecision.reason,
        error: saveDecision.reason,
        diagnostics,
      };
    }

    const serialized = serializeMemory(memory);
    const patch: Record<string, string> = {
      conversation_summary: serialized,
    };

    const { data: updated, error: updateError } = await supabase
      .from("conversations")
      .update(patch)
      .eq("id", id)
      .select("id, conversation_summary")
      .maybeSingle();

    const saved =
      !updateError &&
      !!updated?.conversation_summary?.trim() &&
      !isTrivialEmptySummary(updated.conversation_summary);
    console.log(
      `[backfill] ${forced ? "forced " : ""}save ${id} saved=${saved} compressed=${compressed} bytes=${serialized.length} updateError=${updateError?.message ?? "none"}`
    );

    if (!saved) {
      return {
        conversationId: id,
        status: "failed",
        messageCount,
        messagesFound,
        summaryGenerated: true,
        saved: false,
        skipped: false,
        forced,
        chunks: chunkSummaries.length,
        reason: updateError?.message ?? "save_verify_failed",
        error: updateError?.message ?? "save_verify_failed",
        diagnostics,
      };
    }

    return {
      conversationId: id,
      status: "ok",
      messageCount,
      messagesFound,
      summaryGenerated: true,
      saved: true,
      skipped: false,
      forced,
      chunks: chunkSummaries.length,
      diagnostics,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      conversationId: id,
      status: "failed",
      forced,
      summaryGenerated: false,
      saved: false,
      error: msg,
    };
  }
}

/** Fetch next batch of conversations missing conversation_summary. */
export async function fetchConversationsNeedingBackfill(
  supabase: SupabaseClient,
  limit: number,
  afterLastMessageAt?: string | null
): Promise<BackfillConversationRow[]> {
  let query = supabase
    .from("conversations")
    .select("id, title, conversation_summary, summary, last_message_at")
    .is("deleted_at", null)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(limit * 3);

  if (afterLastMessageAt) {
    query = query.lt("last_message_at", afterLastMessageAt);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[backfill] fetch conversations:", error.message);
    return [];
  }

  return (data ?? [])
    .filter((row) => needsSummaryBackfill(row as BackfillConversationRow))
    .slice(0, limit) as BackfillConversationRow[];
}
