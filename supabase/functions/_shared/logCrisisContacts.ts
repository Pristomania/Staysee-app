/**
 * Fail-open logger for passive crisis/emergency contacts in assistant replies.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  detectCrisisContactsInAssistantReply,
  type DetectedCrisisContact,
} from "./crisisContactLog.ts";
import { logProtocolEvent, type ProtocolEventType } from "./protocolEvents.ts";

export type LogCrisisContactsInput = {
  userId?: string | null;
  conversationId?: string | null;
  requestId?: string | null;
  assistantMessageId?: string | null;
  promptVersion?: string | null;
  model?: string | null;
  assistantText: string;
};

/**
 * Detect contacts in final assistant text and insert protocol_events.
 * Never throws to callers — errors are logged only.
 * Does not mutate or return a modified reply.
 */
export async function logCrisisContactsFromAssistantReply(
  supabase: SupabaseClient | null | undefined,
  input: LogCrisisContactsInput,
): Promise<DetectedCrisisContact[]> {
  try {
    const contacts = detectCrisisContactsInAssistantReply(input.assistantText);
    if (contacts.length === 0) return [];

    for (const contact of contacts) {
      await logProtocolEvent(supabase, {
        userId: input.userId ?? null,
        conversationId: input.conversationId ?? null,
        requestId: input.requestId ?? null,
        eventType: contact.categoryEvent as ProtocolEventType,
        severity: "tier_1",
        protocol: "passive_contact_scan",
        actionTaken: "signal_logged",
        confidence: "high",
        matchedPattern: contact.kind,
        reason: input.assistantMessageId
          ? `assistant_message_id:${input.assistantMessageId}`
          : "assistant_reply_contact",
        promptVersion: input.promptVersion ?? null,
        model: input.model ?? null,
      });
    }

    return contacts;
  } catch (err) {
    console.error("[crisisContactLog] fail-open log error:", err);
    return [];
  }
}
