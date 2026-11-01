/**
 * The tariff constructor: one table of what each plan includes.
 *
 * Nothing about a plan is decided anywhere else in the code. The chat reads the reply ceiling from here (cost.ts
 * builds TIER_CONFIG from it), the features decide what the server builds into an answer and what the app shows
 * unlocked, the app mirrors this file as src/lib/plans.ts (a test keeps the two identical), and the same numbers are
 * enforced in the database (usage_tier_limits, migrations 085 to 087; a test compares them) and shown on the
 * tariffs page of the site. To change a plan, change it here, in the mirror and in the migration, and the tests say
 * if one of the places was forgotten.
 *
 * No imports: this file is shared with the app.
 */

export type PlanId = "free" | "basic" | "premium";

/**
 * Things a plan can switch on. A locked feature stays visible in the app and offers to go to payment.
 * fileAttachments is the whole attach button: documents (read into text by the browser, so only the app can lock
 * them) and pictures (the server refuses those too).
 */
export const PLAN_FEATURES = ["crossMemory", "conversationDynamics", "voiceInput", "fileAttachments"] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/**
 * How good the voice input is, from nothing to the best. "device": the free dictation that runs on the person's own
 * device (works today, not the best quality). "ai": dictation recognised by an AI model (premium; not built yet).
 */
export const VOICE_LEVELS = ["none", "device", "ai"] as const;
export type VoiceInputLevel = (typeof VOICE_LEVELS)[number];

/** Flip to true when the AI voice input exists. Until then the app and the site must not promise it. */
export const AI_VOICE_BUILT = false;

export interface Plan {
  id: PlanId;
  /** What the person sees. */
  label: string;
  /** Rubles per period; 0 is free. */
  priceRub: number;
  /** Length of a paid period; null for the free plan, whose messages come back after idleness instead. */
  periodDays: number | null;
  /** Free plan: calendar months after the last answered message when the messages come back; null for paid plans. */
  renewAfterIdleMonths: number | null;
  /** Messages per period (free: per renewal). Enforced by the database (usage_tier_limits). */
  messages: number;
  /** Active conversations at the same time. Deleting one frees its place. Enforced by the database. */
  maxConversations: number;
  /** The most tokens one reply may have. */
  maxTokensOutput: number;
  /** The yes-or-no features (voice has levels and is separate). */
  features: Record<Exclude<PlanFeature, "voiceInput">, boolean>;
  /** What the plan gives for voice input; see voiceInputFor for what the person really gets today. */
  voiceInput: VoiceInputLevel;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    label: "Бесплатный",
    priceRub: 0,
    periodDays: null,
    renewAfterIdleMonths: 3,
    messages: 50,
    maxConversations: 1,
    maxTokensOutput: 1200,
    // Only the memory of the conversation itself works, and it is not shown. No memory between conversations,
    // no dynamics, typing only, no pictures.
    features: { crossMemory: false, conversationDynamics: false, fileAttachments: false },
    voiceInput: "none",
  },
  basic: {
    id: "basic",
    label: "Базовый",
    priceRub: 1990,
    periodDays: 30,
    renewAfterIdleMonths: null,
    messages: 400,
    maxConversations: 3,
    maxTokensOutput: 1600,
    features: { crossMemory: true, conversationDynamics: true, fileAttachments: true },
    voiceInput: "device",
  },
  premium: {
    id: "premium",
    label: "Премиум",
    priceRub: 4900,
    periodDays: 30,
    renewAfterIdleMonths: null,
    messages: 1000,
    maxConversations: 6,
    maxTokensOutput: 2000,
    features: { crossMemory: true, conversationDynamics: true, fileAttachments: true },
    voiceInput: "ai",
  },
};

export function normalizePlanId(value: unknown): PlanId {
  return value === "basic" || value === "premium" ? value : "free";
}

/** The plan of a person by the tier stored for them; anything unknown is the free plan, never a paid one. */
export function planFor(tier: unknown): Plan {
  return PLANS[normalizePlanId(tier)];
}

export function isFeatureAvailable(tier: unknown, feature: PlanFeature): boolean {
  const plan = planFor(tier);
  return feature === "voiceInput" ? plan.voiceInput !== "none" : plan.features[feature];
}

/**
 * Memory that follows the person between conversations (profile facts and the lifecycle memory) works only when the
 * plan has it AND the person has not switched it off. The memory of the conversation itself is not affected: it works
 * on every plan.
 */
export function crossMemoryActive(tier: unknown, preferenceOn: boolean): boolean {
  return preferenceOn && isFeatureAvailable(tier, "crossMemory");
}

/**
 * The voice input the person really gets: the plan's level, except that the AI input is given only once it is built
 * (premium has the device one until then) and never to a lower plan.
 */
export function voiceInputFor(tier: unknown, aiBuilt: boolean = AI_VOICE_BUILT): VoiceInputLevel {
  const level = planFor(tier).voiceInput;
  return level === "ai" && !aiBuilt ? "device" : level;
}
