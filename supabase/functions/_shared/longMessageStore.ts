/**
 * Storage for the short versions of long messages (table message_model_summaries, service role only).
 * The short version is read by the model and never shown to the person.
 */

export const MESSAGE_MODEL_SUMMARIES_TABLE = "message_model_summaries";
export const MESSAGE_LENGTH_EVENTS_TABLE = "message_length_events";

// The part of a Supabase client this store uses, so tests can use the real client or a fake.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TableClient = { from(table: string): any };

export function createLongMessageStore(client: TableClient) {
  return {
    async loadSummaries(ids: string[]): Promise<Map<string, string>> {
      const found = new Map<string, string>();
      if (ids.length === 0) return found;
      const { data, error } = await client
        .from(MESSAGE_MODEL_SUMMARIES_TABLE)
        .select("message_id, summary")
        .in("message_id", ids);
      if (error) throw new Error("long message summaries could not be read");
      for (const row of (data ?? []) as Array<{ message_id: string; summary: string }>) {
        if (typeof row.message_id === "string" && typeof row.summary === "string") found.set(row.message_id, row.summary);
      }
      return found;
    },

    async saveSummary(row: { id: string; userId: string; summary: string }): Promise<void> {
      const { error } = await client
        .from(MESSAGE_MODEL_SUMMARIES_TABLE)
        .upsert({ message_id: row.id, user_id: row.userId, summary: row.summary }, { onConflict: "message_id" });
      if (error) throw new Error("long message summary could not be saved");
    },
  };
}

/**
 * Notes that a long message (over 4,000 characters) arrived: only its length, never its text, so that over
 * time we can see whether the limit and the context need to grow. Never throws and never delays the reply.
 */
export async function recordLongMessageEvent(client: TableClient, userId: string, charCount: number): Promise<void> {
  try {
    const { error } = await client
      .from(MESSAGE_LENGTH_EVENTS_TABLE)
      .insert({ user_id: userId, kind: "long_message", char_count: charCount });
    if (error) console.error("[long-message-event] not saved");
  } catch {
    console.error("[long-message-event] not saved");
  }
}
