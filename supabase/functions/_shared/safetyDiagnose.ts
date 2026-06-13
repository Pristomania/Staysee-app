/**
 * Debug helpers for safety / role-guard — which rule fired.
 */

import { detectBoundaryTone } from "./boundaryFallback.ts";
import {
  analyzeConversationThread,
  evaluateTurnSafety,
  enforceRoleBoundedReply,
  type ChatTurn,
} from "./roleEnforcement.ts";
import {
  analyzeRoleContamination,
  userImposedRoleOverride,
} from "./roleGuard.ts";
import {
  classifyMessage,
  evaluateSafety,
  isBoundaryPressureMessage,
  isRelationalLifeTurn,
} from "./safety.ts";

export interface SafetyDiagnosis {
  safetyCategory: string;
  roleGuardTriggered: boolean;
  boundedReplyTriggered: boolean;
  matchedRule: string;
  threadEscalated: boolean;
  insistenceLoop: boolean;
  relationalLifeTurn: boolean;
  boundaryTone?: string;
}

export function diagnoseBaseSafety(message: string): string {
  const t = message.trim();
  if (isBoundaryPressureMessage(t)) return "safety:BOUNDARY_PRESSURE_PATTERNS";
  const base = evaluateSafety(t);
  if (base.immediateResponse) return `safety:immediate:${base.category}`;
  return `safety:classify:${classifyMessage(t)}`;
}

export function diagnoseTurn(
  message: string,
  history: ChatTurn[] = [],
  sampleReply = "Слышу тебя. Похоже, сейчас важно просто быть с этим. Что отзывается сильнее всего?"
): SafetyDiagnosis {
  const relational = isRelationalLifeTurn(message);
  const safety = evaluateTurnSafety(message, history);
  const roleState = analyzeRoleContamination(history, message);
  const thread = analyzeConversationThread(history, message);
  const boundedOut = enforceRoleBoundedReply(sampleReply, safety.category, {
    insistenceLoop: safety.insistenceLoop,
    threadEscalated: safety.threadEscalated,
    userMessage: message,
    relationalLifeTurn: relational,
  });

  const roleGuardTriggered =
    roleState.contaminated || Boolean(safety.systemGuidance?.includes("УКАЗАНИЕ РОЛИ"));

  const boundedReplyTriggered = boundedOut.trim() !== sampleReply.trim();

  let matchedRule = diagnoseBaseSafety(message);
  if (relational) matchedRule = "exempt:relational_life_turn";
  else if (userImposedRoleOverride(message)) matchedRule = "roleGuard:userImposedRoleOverride";
  else if (roleState.userOverride) matchedRule = "roleGuard:userOverride";
  else if (roleState.assistantCapitulated) matchedRule = "roleGuard:assistantCapitulated";
  else if (safety.insistenceLoop) matchedRule = "thread:insistence_loop";
  else if (thread.threadEscalated) matchedRule = "thread:escalated";

  const boundaryTone = boundedReplyTriggered
    ? detectBoundaryTone(message)
    : undefined;

  if (boundedReplyTriggered) {
    matchedRule = `boundedReply:${boundaryTone ?? "pivot"}`;
  }

  return {
    safetyCategory: safety.category,
    roleGuardTriggered,
    boundedReplyTriggered,
    matchedRule,
    threadEscalated: thread.threadEscalated,
    insistenceLoop: thread.insistenceLoop,
    relationalLifeTurn: relational,
    boundaryTone,
  };
}

export function logSafetyDiagnosis(
  message: string,
  history: ChatTurn[] = [],
  sampleReply?: string
): SafetyDiagnosis {
  const d = diagnoseTurn(message, history, sampleReply);
  console.log({
    safetyCategory: d.safetyCategory,
    roleGuardTriggered: d.roleGuardTriggered,
    boundedReplyTriggered: d.boundedReplyTriggered,
    matchedRule: d.matchedRule,
    threadEscalated: d.threadEscalated,
    insistenceLoop: d.insistenceLoop,
    relationalLifeTurn: d.relationalLifeTurn,
  });
  return d;
}

export { isRelationalLifeTurn };
