/**
 * StaySee AI — Memory & Context Builder (Layer 4)
 *
 * Builds a compact, cost-controlled context packet before each model call.
 * The packet is injected into the system prompt — never exposed to the user.
 *
 * Imported by: supabase/functions/staysee-chat/index.ts
 *
 * Security:
 * - All DB reads use the user's JWT (respects RLS).
 * - The assembled context block is server-side only.
 * - Never return or log the context packet in response bodies.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  collectMemoryCorrectionHints,
  countMessagesSinceSummary,
  getConversationSummary,
  getParsedMemory,
  injectSummaryIntoPrompt,
  type ConversationMemoryMeta,
} from "./memory.ts";
import type { DurableMemoryCorrection } from "./memoryCorrectionApply.ts";
import {
  loadActiveCorrections,
  memoryCorrectionsEnabled,
} from "./memoryCorrections.ts";
import {
  buildNarrativeContext,
  formatNarrativeForPrompt,
  type WeeklyReflection,
} from "./narrativeEngine.ts";
import {
  formatArchiveExcerptsForPrompt,
  formatUserEvidenceForPrompt,
  type ArchiveExcerpt,
  type UserEvidenceQuote,
} from "./conversationRetrieval.ts";
import { fetchCrossMemoryEnabled } from "./profilePrefs.ts";
import { formatCrossMemoryForPrompt } from "./userLifeMemory.ts";
import { filterCrossMemoryRowsForInjection } from "./crossMemoryPolicy.ts";
import { normalizeMessageRole } from "./messageRole.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecentMessage {
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface ConversationMeta extends ConversationMemoryMeta {
  created_at: string;
  last_message_at: string | null;
  /** Session-only server metadata (processState). Not injected into prompt. */
  metadata: Record<string, unknown> | null;
}

export interface MemoryItem {
  id: string;
  memory_type: string;
  content: string;
  importance: number;
  created_at: string;
  updated_at: string | null;
  last_used_at: string | null;
}

export interface ContextPacketInput {
  conversationId: string;
  userId: string;
  authToken: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface ContextPacket {
  conversationMeta: ConversationMeta | null;
  recentMessages: RecentMessage[];
  memoryItems: MemoryItem[];
  now: string;
  memoryItemIds: string[];
  corrections: string[];
  /** Active durable corrections loaded from memory_corrections (flag-gated). */
  durableCorrections: DurableMemoryCorrection[];
  /** Messages in this conversation since summary_updated_at */
  messagesSinceSummary: number;
  /** Retrieved past exchanges from this conversation only (never other chats). */
  archiveExcerpts: ArchiveExcerpt[];
  /** Verbatim user lines for recall / topic questions (this chat only). */
  userEvidenceQuotes: UserEvidenceQuote[];
  /** Saved weekly dynamics snapshots for this conversation. */
  weeklyReflections: WeeklyReflection[];
}

// ── Max limits ────────────────────────────────────────────────────────────────
// Fetch enough for the largest tier window (20) plus a small buffer.
// Older history is covered by the rolling summary stored on the conversation.

/** Fetch window — tier trim reduces to 12–20 before the model call. */
/** Loaded from DB; tier trim keeps API cost bounded. */
const MAX_RECENT_MESSAGES = 40;
/** Cross-memory: fewer rows, each is a full sentence. */
const MAX_MEMORY_ITEMS = 8;
const MAX_WEEKLY_REFLECTIONS = 3;

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchConversationMeta(
  supabase: ReturnType<typeof createClient>,
  conversationId: string
): Promise<ConversationMeta | null> {
  const fullSelect =
    "id, title, conversation_summary, summary, summary_updated_at, emotional_tone, created_at, last_message_at, metadata";

  let { data, error } = await supabase
    .from("conversations")
    .select(fullSelect)
    .eq("id", conversationId)
    .maybeSingle();

  if (error) {
    console.warn("[context] fetchConversationMeta fallback:", error.message);
    const res = await supabase
      .from("conversations")
      .select("id, title, conversation_summary, summary, created_at, last_message_at, metadata")
      .eq("id", conversationId)
      .maybeSingle();
    data = res.data;
    error = res.error;
  }

  if (error) {
    console.error("[context] fetchConversationMeta:", error.message);
    return null;
  }

  if (!data) return null;
  return {
    ...data,
    summary_updated_at: (data as ConversationMeta).summary_updated_at ?? null,
    emotional_tone: (data as ConversationMeta).emotional_tone ?? null,
    metadata:
      (data as ConversationMeta).metadata &&
      typeof (data as ConversationMeta).metadata === "object" &&
      !Array.isArray((data as ConversationMeta).metadata)
        ? ((data as ConversationMeta).metadata as Record<string, unknown>)
        : null,
  };
}

async function fetchRecentMessages(
  supabase: ReturnType<typeof createClient>,
  conversationId: string
): Promise<RecentMessage[]> {
  // Messages are stored in Supabase for session continuity.
  // Admin UI must not expose message content.
  const { data, error } = await supabase
    .from("messages")
    .select("sender, role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(MAX_RECENT_MESSAGES);
  if (error) console.error("[context] fetchRecentMessages:", error.message);
  if (!data) return [];
  // Reverse so oldest-first for the model
  return data.reverse().map((m) => ({
    role: normalizeMessageRole(m),
    content: m.content,
    created_at: m.created_at,
  }));
}

function normalizeMemoryRow(
  row: Record<string, unknown>
): MemoryItem {
  return {
    id: row.id as string,
    memory_type: row.memory_type as string,
    content: row.content as string,
    importance: typeof row.importance === "number" ? row.importance : 3,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string | null) ?? null,
    last_used_at: (row.last_used_at as string | null) ?? null,
  };
}

async function fetchMemoryItems(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<MemoryItem[]> {
  const rich = await supabase
    .from("user_memory")
    .select("id, memory_type, content, importance, created_at, updated_at, last_used_at")
    .eq("user_id", userId)
    .order("importance", { ascending: false })
    .limit(MAX_MEMORY_ITEMS);

  if (!rich.error && rich.data?.length) {
    return rich.data.map((r) => normalizeMemoryRow(r as Record<string, unknown>));
  }

  if (rich.error) {
    console.warn("[context] fetchMemoryItems fallback:", rich.error.message);
  }

  const basic = await supabase
    .from("user_memory")
    .select("id, memory_type, content, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_MEMORY_ITEMS);

  if (basic.error) {
    console.error("[context] fetchMemoryItems:", basic.error.message);
    return [];
  }

  return (basic.data ?? []).map((r) => normalizeMemoryRow(r as Record<string, unknown>));
}

async function fetchWeeklyReflections(
  supabase: ReturnType<typeof createClient>,
  conversationId: string
): Promise<WeeklyReflection[]> {
  const { data, error } = await supabase
    .from("progress_entries")
    .select("content, created_at, entry_date")
    .eq("conversation_id", conversationId)
    .eq("entry_type", "weekly")
    .order("entry_date", { ascending: false })
    .limit(MAX_WEEKLY_REFLECTIONS);

  if (error) {
    console.warn("[context] fetchWeeklyReflections:", error.message);
    return [];
  }

  return (data ?? [])
    .map((r) => ({
      content: (r.content ?? "").trim(),
      created_at: (r.created_at as string | undefined) ?? undefined,
    }))
    .filter((r) => r.content.length > 0);
}

// ── Stamp memory items as used ────────────────────────────────────────────────

export async function stampMemoryUsed(
  supabase: ReturnType<typeof createClient>,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from("user_memory")
    .update({ last_used_at: new Date().toISOString() })
    .in("id", ids);
  if (error) {
    // Column may be absent on older schemas — non-fatal.
    console.warn("[context] stampMemoryUsed:", error.message);
  }
}

// ── Context prompt builder (rolling summary via memory.ts) ──────────────────

export function buildContextPrompt(packet: ContextPacket): string {
  const meta = packet.conversationMeta;
  const memoryBlock = injectSummaryIntoPrompt({
    conversationSummary: getConversationSummary(meta),
    conversationTitle: meta?.title,
    emotionalTone: meta?.emotional_tone,
    corrections: packet.corrections,
    durableCorrections: packet.durableCorrections,
  });

  const parts: string[] = [];
  if (memoryBlock) parts.push(memoryBlock);

  const injectableCrossMemory =
    packet.memoryItems.length > 0
      ? filterCrossMemoryRowsForInjection(packet.memoryItems)
      : [];

  if (injectableCrossMemory.length > 0) {
    const crossBlock = formatCrossMemoryForPrompt(injectableCrossMemory);
    if (crossBlock) parts.push(crossBlock);
  }

  const narrativeBlock = formatNarrativeForPrompt(
    buildNarrativeContext({
      summary: getParsedMemory(meta) ?? undefined,
      weekly: packet.weeklyReflections,
      crossMemory: injectableCrossMemory,
      recentMessages: packet.recentMessages,
    })
  );
  if (narrativeBlock) parts.push(narrativeBlock);

  const evidenceBlock = formatUserEvidenceForPrompt(
    packet.userEvidenceQuotes ?? []
  );
  if (evidenceBlock) parts.push(evidenceBlock);

  const archiveBlock = formatArchiveExcerptsForPrompt(
    packet.archiveExcerpts ?? []
  );
  if (archiveBlock) parts.push(archiveBlock);

  if (parts.length > 0) {
    parts.push(
      "Перед ответом сверь: ПОДТВЕРЖДЁННЫЕ СЛОВА и реплики пользователя в АРХИВЕ (факты) → ПАМЯТЬ БЕСЕДЫ (темы) → СКВОЗНУЮ ПАМЯТЬ → последние реплики. " +
        "Учитывай предыдущий контекст как внутреннюю ориентацию ответа. Другие чаты не используй."
    );
  }

  return parts.join("\n\n");
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildContextPacket(
  input: ContextPacketInput
): Promise<ContextPacket> {
  const supabase = createClient(input.supabaseUrl, input.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${input.authToken}` } },
  });

  const [conversationMeta, recentMessages, crossMemoryOn, weeklyReflections] =
    await Promise.all([
      fetchConversationMeta(supabase, input.conversationId),
      fetchRecentMessages(supabase, input.conversationId),
      fetchCrossMemoryEnabled(supabase, input.userId),
      fetchWeeklyReflections(supabase, input.conversationId),
    ]);

  const memoryItems = crossMemoryOn
    ? await fetchMemoryItems(supabase, input.userId)
    : [];

  const corrections = collectMemoryCorrectionHints(recentMessages);
  const durableCorrections = memoryCorrectionsEnabled()
    ? await loadActiveCorrections(supabase, input.userId, input.conversationId)
    : [];
  const messagesSinceSummary = await countMessagesSinceSummary(
    supabase,
    input.conversationId,
    conversationMeta?.summary_updated_at ?? null
  );

  return {
    conversationMeta,
    recentMessages,
    memoryItems,
    now: new Date().toISOString(),
    memoryItemIds: memoryItems.map((m) => m.id),
    corrections,
    durableCorrections,
    messagesSinceSummary,
    archiveExcerpts: [],
    userEvidenceQuotes: [],
    weeklyReflections,
  };
}
