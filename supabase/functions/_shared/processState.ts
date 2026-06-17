/**
 * Process state shadow — audit-only mapping from typed routing signals.
 * Does not affect routing, prompts, responses, or memory.
 */

import type {
  OpenFigureConfidence,
  OpenFigureIntensity,
  ResponseDepth,
} from "./responseDepthTrajectory.ts";

export type ProcessContact = "active" | "reduced" | "distant" | "closing";
export type ProcessMovement =
  | "opening"
  | "stuck"
  | "deepening"
  | "integrating"
  | "settling";
export type ProcessClosure =
  | "none"
  | "user_closing"
  | "system_should_not_close";
export type ProcessCertainty = "low" | "medium" | "high";
export type ProcessStateSource = "structural_shadow";

export interface ProcessState {
  contact: ProcessContact;
  movement: ProcessMovement;
  closure: ProcessClosure;
  certainty: ProcessCertainty;
  source: ProcessStateSource;
}

export type SafetyCategory =
  | "normal"
  | "crisis"
  | "off_topic"
  | "boundary_pressure"
  | "medical_boundary"
  | "legal_financial_boundary"
  | "prompt_attack"
  | "dependency_risk";

export interface ComputeProcessStateInput {
  openFigure: {
    isOpen: boolean;
    intensity: OpenFigureIntensity;
    confidence: OpenFigureConfidence;
  };
  depth: ResponseDepth;
  explicitClosure: boolean;
  uncertainty: boolean;
  recentUserTurns: number;
  safetyCategory: SafetyCategory;
}

function openFigureCertainty(
  confidence: OpenFigureConfidence,
  uncertainty: boolean
): ProcessCertainty {
  if (uncertainty) return "low";
  if (confidence === "high") return "medium";
  return "low";
}

function openFigureMovement(
  intensity: OpenFigureIntensity,
  uncertainty: boolean
): ProcessMovement {
  if (uncertainty) return "stuck";
  if (intensity === "high") return "stuck";
  return "opening";
}

export function computeProcessState(
  input: ComputeProcessStateInput
): ProcessState {
  if (input.explicitClosure) {
    return {
      contact: "closing",
      movement: "settling",
      closure: "user_closing",
      certainty: "high",
      source: "structural_shadow",
    };
  }

  if (input.safetyCategory === "crisis") {
    return {
      contact: "active",
      movement: "stuck",
      closure: "system_should_not_close",
      certainty: "low",
      source: "structural_shadow",
    };
  }

  if (input.openFigure.isOpen) {
    return {
      contact: "active",
      movement: openFigureMovement(
        input.openFigure.intensity,
        input.uncertainty
      ),
      closure: "system_should_not_close",
      certainty: openFigureCertainty(
        input.openFigure.confidence,
        input.uncertainty
      ),
      source: "structural_shadow",
    };
  }

  if (input.uncertainty) {
    return {
      contact: "reduced",
      movement: "opening",
      closure: "none",
      certainty: "low",
      source: "structural_shadow",
    };
  }

  return {
    contact: "reduced",
    movement: "settling",
    closure: "none",
    certainty: "medium",
    source: "structural_shadow",
  };
}
