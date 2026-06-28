/**
 * Durable memory corrections — DB load/persist (feature-flagged).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { MemoryCorrectionCandidate } from "./memoryCorrectionDetect.ts";
import type { DurableMemoryCorrection } from "./memoryCorrectionApply.ts";

export function memoryCorrectionsEnabled(): boolean {
  return Deno.env.get("STAYSEE_MEMORY_CORRECTIONS") === "1";
}

export function candidateToDurable(
  candidate: MemoryCorrectionCandidate
): DurableMemoryCorrection {
  return {
    subject_key: candidate.subjectKey,
    correction_text: candidate.correctionText,
    display_text: candidate.displayText,
    old_text: candidate.oldText ?? null,
    scope: candidate.scope,
  };
}

/** Merge loaded corrections with same-turn extras (extras win per subject_key). */
export function mergeDurableCorrections(
  loaded: DurableMemoryCorrection[],
  extras: DurableMemoryCorrection[]
): DurableMemoryCorrection[] {
  const bySubject = new Map<string, DurableMemoryCorrection>();
  for (const c of loaded) bySubject.set(c.subject_key, c);
  for (const c of extras) bySubject.set(c.subject_key, c);
  return [...bySubject.values()];
}

export interface PersistMemoryCorrectionInput {
  userId: string;
  conversationId: string | null;
  sourceMessageId?: string | null;
  candidate: MemoryCorrectionCandidate;
}

const SELECT_FIELDS =
  "id, subject_key, correction_text, display_text, old_text, scope, active, conversation_id";

function rowToDurable(row: Record<string, unknown>): DurableMemoryCorrection {
  return {
    subject_key: String(row.subject_key),
    correction_text: String(row.correction_text),
    display_text: String(row.display_text),
    old_text: row.old_text != null ? String(row.old_text) : null,
    scope: row.scope as "conversation" | "global",
  };
}

/** Load active global + conversation-scoped corrections for prompt/merge. */
export async function loadActiveCorrections(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string | null
): Promise<DurableMemoryCorrection[]> {
  if (!memoryCorrectionsEnabled()) return [];

  const { data: globalRows, error: globalErr } = await supabase
    .from("memory_corrections")
    .select(SELECT_FIELDS)
    .eq("user_id", userId)
    .eq("scope", "global")
    .eq("active", true);

  if (globalErr) {
    console.warn("[memoryCorrections] load global:", globalErr.message);
    return [];
  }

  let conversationRows: Record<string, unknown>[] = [];
  if (conversationId) {
    const { data, error } = await supabase
      .from("memory_corrections")
      .select(SELECT_FIELDS)
      .eq("user_id", userId)
      .eq("scope", "conversation")
      .eq("conversation_id", conversationId)
      .eq("active", true);
    if (error) {
      console.warn("[memoryCorrections] load conversation:", error.message);
    } else {
      conversationRows = data ?? [];
    }
  }

  const bySubject = new Map<string, DurableMemoryCorrection>();
  for (const row of globalRows ?? []) {
    bySubject.set(String(row.subject_key), rowToDurable(row));
  }
  for (const row of conversationRows) {
    bySubject.set(String(row.subject_key), rowToDurable(row));
  }

  return [...bySubject.values()];
}

/** Supersede prior active row and insert new correction. */
export async function persistMemoryCorrection(
  supabase: SupabaseClient,
  input: PersistMemoryCorrectionInput
): Promise<boolean> {
  if (!memoryCorrectionsEnabled()) return false;

  const { userId, conversationId, sourceMessageId, candidate } = input;
  if (candidate.scope === "conversation" && !conversationId) {
    console.warn("[memoryCorrections] skip persist: conversation scope without conversationId");
    return false;
  }

  const now = new Date().toISOString();

  let deactivateQuery = supabase
    .from("memory_corrections")
    .update({ active: false, updated_at: now })
    .eq("user_id", userId)
    .eq("scope", candidate.scope)
    .eq("subject_key", candidate.subjectKey)
    .eq("active", true);

  if (candidate.scope === "conversation") {
    deactivateQuery = deactivateQuery.eq("conversation_id", conversationId!);
  } else {
    deactivateQuery = deactivateQuery.is("conversation_id", null);
  }

  const { error: deactivateErr } = await deactivateQuery;
  if (deactivateErr) {
    console.warn("[memoryCorrections] deactivate:", deactivateErr.message);
    return false;
  }

  const { error: insertErr } = await supabase.from("memory_corrections").insert({
    user_id: userId,
    conversation_id: candidate.scope === "conversation" ? conversationId : null,
    source_message_id: sourceMessageId ?? null,
    subject_key: candidate.subjectKey,
    correction_text: candidate.correctionText,
    display_text: candidate.displayText,
    old_text: candidate.oldText ?? null,
    scope: candidate.scope,
    active: true,
    updated_at: now,
  });

  if (insertErr) {
    console.warn("[memoryCorrections] insert:", insertErr.message);
    return false;
  }

  console.log(
    `[memoryCorrections] persisted subject=${candidate.subjectKey} scope=${candidate.scope}`
  );
  return true;
}
