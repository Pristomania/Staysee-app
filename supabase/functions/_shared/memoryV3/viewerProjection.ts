export interface MemoryV3ViewerSourceItem {
  memoryKey: string;
  kind: "event" | "recurrence" | "hypothesis";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
  topic: string | null;
}

export interface MemoryV3ViewerItem {
  memoryKey: string;
  kind: "event" | "recurrence";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
  topic: string | null;
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
    }));
}
