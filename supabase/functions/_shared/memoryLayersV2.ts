/**
 * StaySee — Memory Layers V2 (design draft)
 *
 * Проект новой архитектуры памяти: facts / hypotheses / coping_patterns.
 * НЕ подключён к runtime. Не заменяет StructuredMemory в memory.ts.
 *
 * Цель: epistemic separation — факты ≠ гипотезы ≠ способы обходиться с жизнью.
 * Источник истины для facts: messages (user role only).
 *
 * Будущие потребители:
 * - memory.ts — сборка, merge, inject
 * - summaryRefresh.ts — промпт rolling summary
 * - userLifeMemory.ts — только стабильные facts + communication из coping
 * - context.ts — inject с явными метками epistemic
 * - MemoryScreen.tsx — UI по слоям
 * - backfillMemory.ts — пересборка из messages
 */

// ── Epistemic markers ─────────────────────────────────────────────────────────

export type MemoryEpistemic =
  | "user_said"       // дословно или явно подтверждено пользователем
  | "user_corrected"  // поправка пользователя (высший приоритет)
  | "hypothesis"      // предположение Стэйси, требует проверки
  | "observed"        // повторяющийся паттерн в репликах (не мотив)
  | "inferred_coping"; // способ обходиться с жизнью (из поведения в тексте)

export type CopingPatternKind =
  | "avoids"
  | "explains"
  | "endures"
  | "takes_responsibility"
  | "acts_out"
  | "seeks_support"
  | "freezes"
  | "controls"
  | "adapts";

export const COPING_PATTERN_LABELS: Record<CopingPatternKind, string> = {
  avoids: "избегает",
  explains: "объясняет",
  endures: "терпит",
  takes_responsibility: "берёт ответственность",
  acts_out: "уходит в действия",
  seeks_support: "ищет поддержку",
  freezes: "замораживается",
  controls: "контролирует",
  adapts: "приспосабливается",
};

// ── Layer 1: Facts ────────────────────────────────────────────────────────────

export interface MemoryFactV2 {
  /** Краткая формулировка факта своими словами пользователя. */
  text: string;
  epistemic: "user_said" | "user_corrected";
  /** Опционально: id сообщения-источника (будущая колонка / audit). */
  sourceMessageId?: string;
  /** ISO — когда зафиксирован. */
  recordedAt: string;
  /** Категория для UI и caps. */
  category?: "identity" | "relation" | "event" | "circumstance" | "preference_stated";
}

// ── Layer 2: Hypotheses ───────────────────────────────────────────────────────

export interface MemoryHypothesisV2 {
  text: string;
  epistemic: "hypothesis" | "observed";
  /** Тема, переживание, конфликт, закономерность. */
  kind: "theme" | "feeling" | "inner_conflict" | "pattern" | "open_thread";
  /** Сколько раз паттерн встречался в user messages (не в ответах AI). */
  evidenceCount?: number;
  recordedAt: string;
  /** После подтверждения пользователем — promote to fact (отдельный pipeline). */
  confirmedAt?: string | null;
}

// ── Layer 3: Coping patterns ──────────────────────────────────────────────────

export interface MemoryCopingPatternV2 {
  kind: CopingPatternKind;
  /** Как это проявляется в её словах (без ярлыка в ответе пользователю). */
  description: string;
  epistemic: "inferred_coping" | "user_said";
  evidenceCount?: number;
  recordedAt: string;
}

// ── Per-conversation bundle ───────────────────────────────────────────────────

export interface ConversationMemoryV2 {
  facts: MemoryFactV2[];
  hypotheses: MemoryHypothesisV2[];
  coping_patterns: MemoryCopingPatternV2[];
  last_updated: string;
  /** Schema version for migration tooling. */
  schema_version: 2;
}

// ── Cross-conversation (user_memory v2 projection) ────────────────────────────

/**
 * Сквозная память — только то, что переносимо между чатами:
 * - стабильные facts (имя, проживание — если user_said)
 * - coping patterns с evidence >= 2
 * - communication preferences (из facts category preference_stated)
 * Гипотезы НЕ промотируются в сквозную память без подтверждения.
 */
export interface CrossMemoryProjectionV2 {
  stable_facts: MemoryFactV2[];
  coping_patterns: MemoryCopingPatternV2[];
  communication_notes: string[];
}

// ── Caps (mirror current memory.ts discipline) ────────────────────────────────

export const MEMORY_V2_CAPS = {
  facts: 12,
  hypotheses: 10,
  coping_patterns: 8,
} as const;

export const MEMORY_V2_MAX_ITEM_CHARS = 200;

// ── Empty factory ─────────────────────────────────────────────────────────────

export function emptyConversationMemoryV2(): ConversationMemoryV2 {
  return {
    facts: [],
    hypotheses: [],
    coping_patterns: [],
    last_updated: new Date().toISOString(),
    schema_version: 2,
  };
}

// ── Mapping notes: StructuredMemory → V2 (future migration helper) ────────────

/**
 * Черновик соответствия текущих полей (memory.ts) → V2.
 * Не выполнять автоматически без human review / LLM re-tag.
 *
 * | StructuredMemory field   | V2 target              | Risk                          |
 * |--------------------------|------------------------|-------------------------------|
 * | important_events         | facts                  | Могут содержать интерпретации |
 * | people                   | facts (identity)       | Часто bare names              |
 * | preferences              | facts или coping       | Зависит от формулировки       |
 * | themes                   | hypotheses (theme)     |                               |
 * | emotional_state          | hypotheses (feeling)   | Интерпретация                 |
 * | open_loops               | hypotheses (open_thread)|                              |
 * | risks                    | facts (circumstance)   | Только user-confirmed crisis  |
 */
export const MEMORY_V1_TO_V2_MAPPING_NOTES = `
important_events → facts (только после верификации по messages)
people → facts.category identity | relation
preferences → facts.preference_stated | coping_patterns (если про стиль совладания)
themes → hypotheses.kind theme
emotional_state → hypotheses.kind feeling
open_loops → hypotheses.kind open_thread
risks → facts только при user_said; иначе отбросить или hypothesis
`.trim();
