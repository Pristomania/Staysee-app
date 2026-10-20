/**
 * Switch for the legacy rolling conversation summary ("ПАМЯТЬ БЕСЕДЫ").
 *
 * Memory V3 now carries the conversation's facts, so the old summary is a second,
 * partly overlapping notebook that is rewritten on (nearly) every reply, and its
 * phrase-catching "correction" detector can force that rewrite over and over.
 * STAYSEE_LEGACY_SUMMARY_OFF turns the whole legacy summary path off without
 * deleting anything:
 *   unset / blank        -> ON for everyone (current behaviour; the safe default)
 *   "all"                -> OFF for every account
 *   "<uuid>,<uuid>,..."  -> OFF only for the listed accounts
 * Anything unrecognised keeps it ON: a typo must never switch memory off.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isLegacySummaryDisabled(
  userId: string,
  raw: string | null | undefined,
): boolean {
  if (typeof raw !== "string") return false;
  const setting = raw.trim().toLowerCase();
  if (setting === "") return false;
  const id = typeof userId === "string" ? userId.trim().toLowerCase() : "";
  if (!UUID.test(id)) return false;
  if (setting === "all") return true;
  return setting
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => UUID.test(entry))
    .includes(id);
}

type PacketWithSummary = { conversationMeta: object | null; corrections: unknown[] };

// What the reply sees when the legacy summary is off: no summary text, no tone
// derived from it, no refresh timestamp, and none of the phrase-catcher
// "corrections". Everything else (title, messages, V3 memory, archive) is untouched.
// The input is not modified.
export function withoutLegacySummary<P extends PacketWithSummary>(packet: P): P {
  return {
    ...packet,
    conversationMeta: packet.conversationMeta === null
      ? null
      : {
        ...packet.conversationMeta,
        conversation_summary: null,
        summary: null,
        emotional_tone: null,
        summary_updated_at: null,
      },
    corrections: [],
  } as P;
}
