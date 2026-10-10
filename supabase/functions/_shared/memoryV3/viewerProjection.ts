export interface MemoryV3ViewerSourceItem {
  memoryKey: string;
  kind: "event" | "recurrence" | "hypothesis";
  claim: string;
  status: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
  topic: string | null;
  firstSeenAt: string;
  updatedAt: string;
  alternative: string | null;
  /** Only present on rows from load_memory_v3_dialogue_viewer_items_all --
   * absent (never present) on lifecycle rows, which have no conversation. */
  conversationId?: string;
  replacesMemoryKey?: string | null;
  replacedByMemoryKey?: string | null;
}

export interface MemoryV3ViewerItem {
  memoryKey: string;
  kind: "event" | "recurrence";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
  topic: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

export interface MemoryV3ExportItem {
  memoryKey: string;
  kind: "event" | "recurrence" | "hypothesis";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
  topic: string | null;
  firstSeenAt: string;
  updatedAt: string;
  alternative: string | null;
  /** The conversation this fact came from, or null for account-wide
   * (lifecycle) facts. Lets a multi-conversation export tell apart two
   * identical-looking facts that were independently noticed in different
   * conversations, instead of them reading as an unexplained duplicate. */
  conversationId: string | null;
  replacesMemoryKey: string | null;
  replacedByMemoryKey: string | null;
}

// The extractor prompt now tells the model never to write "пользователь"/
// "клиент" as a claim's subject (see prompt.ts), so this only matters for
// claims already stored before that fix shipped. Display-only cleanup --
// never rewrites what's actually stored in the database.
const LEADING_SUBJECT_WORD_RE = /^(?:пользователь|клиент)\s*[:,-]?\s+(\S.*)$/iu;

function stripLeadingSubjectWord(claim: string): string {
  const match = LEADING_SUBJECT_WORD_RE.exec(claim);
  if (!match) return claim;
  const rest = match[1];
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Curates raw Memory V3 items for the user-facing viewer: confirmed
 * facts and patterns only, never a hypothesis. */
export function projectMemoryV3ViewerItems(
  items: MemoryV3ViewerSourceItem[],
): MemoryV3ViewerItem[] {
  return items
    .filter((item): item is MemoryV3ViewerSourceItem & { kind: "event" | "recurrence" } =>
      item.kind === "event" || item.kind === "recurrence")
    .map((item) => ({
      memoryKey: item.memoryKey,
      kind: item.kind,
      claim: stripLeadingSubjectWord(item.claim),
      eventTimeStart: item.eventTimeStart,
      eventTimeEnd: item.eventTimeEnd,
      sensitivity: item.sensitivity,
      topic: item.topic,
      firstSeenAt: item.firstSeenAt,
      updatedAt: item.updatedAt,
    }));
}

/** Curates raw Memory V3 items for a full data export: every kind,
 * including hypotheses with their alternative explanation -- unlike the
 * day-to-day viewer, this is meant to be a complete, transparent copy of
 * what the account holds, not a curated read. A hypothesis the AI itself
 * never confirmed (status other than "supported" -- candidate, stale, or
 * rejected) is left out: the AI's own read-context prompt only ever acts
 * on a "supported" hypothesis, so a discarded guess isn't something the
 * app actually "remembers" and showing it to the user (especially in a
 * psychologically sensitive app) would be misleading, not transparent.
 * Events and recurrences are never filtered by status here -- only the
 * hypothesis kind has this extra check. */
export function projectMemoryV3ExportItems(
  items: MemoryV3ViewerSourceItem[],
): MemoryV3ExportItem[] {
  return items
    .filter((item) => item.kind !== "hypothesis" || item.status === "supported")
    .map((item) => ({
      memoryKey: item.memoryKey,
      kind: item.kind,
      claim: stripLeadingSubjectWord(item.claim),
      eventTimeStart: item.eventTimeStart,
      eventTimeEnd: item.eventTimeEnd,
      sensitivity: item.sensitivity,
      topic: item.topic,
      firstSeenAt: item.firstSeenAt,
      updatedAt: item.updatedAt,
      alternative: item.alternative,
      conversationId: item.conversationId ?? null,
      replacesMemoryKey: item.replacesMemoryKey ?? null,
      replacedByMemoryKey: item.replacedByMemoryKey ?? null,
    }));
}
