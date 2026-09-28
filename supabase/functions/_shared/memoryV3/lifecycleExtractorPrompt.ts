import {
  MEMORY_V3_EXTRACTOR_SHARED_INSTRUCTION,
  buildMemoryV3ExtractorRequestForInstruction,
} from "./extractorRequest.ts";
import type { MemoryV3ExtractorRequest } from "./extractorRequest.ts";

export const MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION =
  "memory-v3-openrouter-gemini-3.7-flash-lifecycle-extractor-v1" as const;

export const MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION = `You extract StaySEE lifecycle memory for use across unrelated future conversations.

${MEMORY_V3_EXTRACTOR_SHARED_INSTRUCTION}

LIFECYCLE SCOPE POLICY — this final selection policy is mandatory:
- Emit only one short atomic cross-conversation fact per item.
- One clear user statement is enough for an allowed stable fact; repetition is not required.
- Allow only: name; age or birthday; current geography; occupation or durable field of activity; current family relationship; stable close friendship; pet; current living arrangement; long-term project or role; durable preference for address, tone, directness, or what helps in contact.
- When a story contains an allowed stable core, distill only that core as a separate claim.
- Omit event chronology, conflict history, health, medical information, personal therapy, religion, and third-party plans. Also omit temporary states, incidental property detail, and another person's biography.
- An unqualified "запомни" permits evaluation but never expands this allowlist.
- "запомни здесь" is conversation-only wording: omit the item from lifecycle memory even when its core would otherwise be allowed.
- Explicit global wording such as "запомни для всех разговоров" still remains subject to this allowlist and atomic-claim rule.

Locked scope examples (source => lifecycle decision):
- Сын съехал и может уйти в армию => Есть сын
- С Димой дважды расходились, сейчас вместе => Состоит в отношениях с Димой
- Живет одна в доме площадью 100 м² => Живет одна
- Не употребляет алкоголь из-за страха за здоровье => omit
- Проходила личную и групповую терапию и училась консультированию => omit personal therapy; separately evidenced professional role only
- Запомни здесь: у меня есть сын => omit because conversation-only
- Запомни: у меня есть сын => Есть сын`;

export function buildMemoryV3LifecycleExtractorRequest(
  input: unknown,
): MemoryV3ExtractorRequest {
  return buildMemoryV3ExtractorRequestForInstruction(
    input,
    MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION,
  );
}
