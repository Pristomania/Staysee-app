/**
 * Structured turn JSON schema — processState + openFigure + response.
 * Pure types/constants for PR3b parser; no runtime / Deno imports.
 */

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

export type OpenFigureKind =
  | "emotional"
  | "relational"
  | "body"
  | "identity"
  | "choice"
  | "unknown";

export type OpenFigureIntensity = "low" | "medium" | "high";
export type OpenFigureConfidence = "low" | "medium" | "high";

export interface StructuredProcessState {
  contact: ProcessContact;
  movement: ProcessMovement;
  closure: ProcessClosure;
  certainty: ProcessCertainty;
}

export interface StructuredOpenFigure {
  isOpen: boolean;
  kind: OpenFigureKind;
  intensity: OpenFigureIntensity;
  confidence: OpenFigureConfidence;
}

export interface StructuredTurn {
  processState: StructuredProcessState;
  openFigure: StructuredOpenFigure;
  response: string;
}

export const STRUCTURED_TURN_TOP_LEVEL_KEYS = [
  "processState",
  "openFigure",
  "response",
] as const;

export const PROCESS_STATE_KEYS = [
  "contact",
  "movement",
  "closure",
  "certainty",
] as const;

export const OPEN_FIGURE_KEYS = [
  "isOpen",
  "kind",
  "intensity",
  "confidence",
] as const;

export const PROCESS_CONTACTS: readonly ProcessContact[] = [
  "active",
  "reduced",
  "distant",
  "closing",
];

export const PROCESS_MOVEMENTS: readonly ProcessMovement[] = [
  "opening",
  "stuck",
  "deepening",
  "integrating",
  "settling",
];

export const PROCESS_CLOSURES: readonly ProcessClosure[] = [
  "none",
  "user_closing",
  "system_should_not_close",
];

export const PROCESS_CERTAINTIES: readonly ProcessCertainty[] = [
  "low",
  "medium",
  "high",
];

export const OPEN_FIGURE_KINDS: readonly OpenFigureKind[] = [
  "emotional",
  "relational",
  "body",
  "identity",
  "choice",
  "unknown",
];

export const OPEN_FIGURE_INTENSITIES: readonly OpenFigureIntensity[] = [
  "low",
  "medium",
  "high",
];

export const OPEN_FIGURE_CONFIDENCES: readonly OpenFigureConfidence[] = [
  "low",
  "medium",
  "high",
];

/** Hard-reject keys anywhere in parsed JSON (case-insensitive match). */
export const FORBIDDEN_KEYS = new Set([
  "reasoning",
  "chain_of_thought",
  "explanation",
  "diagnosis",
  "interpretation",
  "evidence",
  "quotes",
  "raw_message",
  "trauma",
  "attachment",
  "dependency",
  "fear_of_abandonment",
  "pattern",
  "clinical_label",
]);

export const RESPONSE_MIN_LENGTH = 1;
export const RESPONSE_MAX_LENGTH = 4000;

const STRUCTURED_TURN_SCHEMA_NAME = "staysee_structured_turn";

/** JSON Schema for OpenRouter / strict structured output (PR3b+). */
export function buildStructuredTurnJsonSchema(): Record<string, unknown> {
  return {
    name: STRUCTURED_TURN_SCHEMA_NAME,
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["processState", "openFigure", "response"],
      properties: {
        processState: {
          type: "object",
          additionalProperties: false,
          required: ["contact", "movement", "closure", "certainty"],
          properties: {
            contact: { type: "string", enum: [...PROCESS_CONTACTS] },
            movement: { type: "string", enum: [...PROCESS_MOVEMENTS] },
            closure: { type: "string", enum: [...PROCESS_CLOSURES] },
            certainty: { type: "string", enum: [...PROCESS_CERTAINTIES] },
          },
        },
        openFigure: {
          type: "object",
          additionalProperties: false,
          required: ["isOpen", "kind", "intensity", "confidence"],
          properties: {
            isOpen: { type: "boolean" },
            kind: { type: "string", enum: [...OPEN_FIGURE_KINDS] },
            intensity: { type: "string", enum: [...OPEN_FIGURE_INTENSITIES] },
            confidence: { type: "string", enum: [...OPEN_FIGURE_CONFIDENCES] },
          },
        },
        response: {
          type: "string",
          minLength: RESPONSE_MIN_LENGTH,
          maxLength: RESPONSE_MAX_LENGTH,
        },
      },
    },
  };
}
