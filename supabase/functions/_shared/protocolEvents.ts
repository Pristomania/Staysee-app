/**
 * PII-free protocol_events insert — service role, fire-and-forget.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ProtocolSignalName } from "./protocolSignalParser.ts";

export type ProtocolEventType =
  | "crisis_hard_stop"
  | "crisis_detected"
  | "role_attack_detected"
  | "boundary_pressure_detected"
  | "prompt_attack_hard_stop"
  | "tag_leak_sanitized";

export type ProtocolSeverity = "tier_1" | "tier_2" | "tier_3";

export type ProtocolActionTaken =
  | "hard_stop"
  | "guidance_injected"
  | "signal_logged"
  | "model_response"
  | "sanitized";

export interface ProtocolEventInput {
  userId?: string | null;
  conversationId?: string | null;
  requestId?: string | null;
  eventType: ProtocolEventType;
  severity: ProtocolSeverity;
  protocol: string;
  actionTaken: ProtocolActionTaken;
  confidence: "high" | "medium" | "low" | "n/a";
  reason?: string | null;
  matchedPattern?: string | null;
  classifierSummary?: string | null;
  promptVersion?: string | null;
  model?: string | null;
  signalCount?: number;
  signalsStripped?: ProtocolSignalName[] | null;
}

export function buildProtocolEventRow(input: ProtocolEventInput) {
  return {
    user_id: input.userId ?? null,
    conversation_id: input.conversationId ?? null,
    request_id: input.requestId ?? null,
    event_type: input.eventType,
    severity: input.severity,
    protocol: input.protocol,
    action_taken: input.actionTaken,
    confidence: input.confidence,
    reason: input.reason ?? null,
    matched_pattern: input.matchedPattern ?? null,
    classifier_summary: input.classifierSummary ?? null,
    prompt_version: input.promptVersion ?? null,
    model: input.model ?? null,
    signal_count: input.signalCount ?? 0,
    signals_stripped: input.signalsStripped ?? null,
  };
}

export async function logProtocolEvent(
  supabase: SupabaseClient | null | undefined,
  input: ProtocolEventInput
): Promise<void> {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from("protocol_events")
      .insert(buildProtocolEventRow(input));
    if (error) {
      console.error("[protocol_events] insert:", error.message);
    }
  } catch (err) {
    console.error("[protocol_events] insert failed:", err);
  }
}

export async function logProtocolSignals(
  supabase: SupabaseClient | null | undefined,
  base: Omit<ProtocolEventInput, "eventType" | "severity" | "protocol" | "actionTaken" | "confidence">,
  signals: ProtocolSignalName[],
  opts?: { leakageSanitized?: boolean }
): Promise<void> {
  if (signals.length === 0 && !opts?.leakageSanitized) return;

  if (opts?.leakageSanitized) {
    await logProtocolEvent(supabase, {
      ...base,
      eventType: "tag_leak_sanitized",
      severity: "tier_2",
      protocol: "signal_sanitizer",
      actionTaken: "sanitized",
      confidence: "high",
      reason: "partial_or_unknown_staysee_signal_stripped",
      signalCount: signals.length,
      signalsStripped: signals.length ? signals : null,
    });
  }

  if (signals.length === 0) return;

  const primary = signals[0];
  const eventType: ProtocolEventType =
    primary === "crisis_detected"
      ? "crisis_detected"
      : primary === "role_attack_detected"
        ? "role_attack_detected"
        : "boundary_pressure_detected";

  await logProtocolEvent(supabase, {
    ...base,
    eventType,
    severity: "tier_1",
    protocol: "model_signal",
    actionTaken: "signal_logged",
    confidence: "medium",
    reason: signals.length > 1 ? `multi_signal:${signals.join(",")}` : null,
    signalCount: signals.length,
    signalsStripped: signals,
  });
}
