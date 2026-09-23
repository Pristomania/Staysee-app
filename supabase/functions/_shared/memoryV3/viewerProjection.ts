export interface MemoryV3ViewerSourceItem {
  memoryKey: string;
  kind: "event" | "recurrence" | "hypothesis";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
}

export interface MemoryV3ViewerItem {
  memoryKey: string;
  kind: "event" | "recurrence";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
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
      claim: item.claim,
      eventTimeStart: item.eventTimeStart,
      eventTimeEnd: item.eventTimeEnd,
      sensitivity: item.sensitivity,
    }));
}
