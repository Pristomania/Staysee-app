import {
  MEMORY_V3_EXTRACTOR_SHARED_INSTRUCTION,
  buildMemoryV3ExtractorRequestForInstruction,
} from "./extractorRequest.ts";
import type { MemoryV3ExtractorRequest } from "./extractorRequest.ts";

export const MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION =
  "memory-v3-openrouter-gemini-3.7-flash-dialogue-extractor-v1" as const;

export const MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION = `You extract StaySEE dialogue memory that helps when the same conversation continues.

${MEMORY_V3_EXTRACTOR_SHARED_INSTRUCTION}

DIALOGUE SCOPE POLICY — this final selection policy is mandatory:
- Retain useful conversation-local people, facts, preferences, events, decisions, conflict history, and bounded narrative context.
- Temporary context may be retained when it is useful for continuing this conversation.
- Safe user-originated sensitive context may be retained locally when relevant, but never infer diagnosis or clinical labels.
- An explicit request to remember is sufficient evidence of local usefulness when the content is safe and user-originated.
- "запомни здесь" explicitly authorizes dialogue-only evaluation; it never authorizes lifecycle storage.
- Keep claims bounded to what the user actually said and preserve uncertainty.

Locked scope examples (source => dialogue decision):
- Сын съехал и может уйти в армию => may retain move and army context
- С Димой дважды расходились, сейчас вместе => may retain breakup history
- Живет одна в доме площадью 100 м² => may retain property detail when relevant
- Не употребляет алкоголь из-за страха за здоровье => may retain locally when relevant and safe
- Проходила личную и групповую терапию и училась консультированию => may retain therapy context when relevant and safe
- Запомни здесь: у меня есть сын => admit
- Запомни: у меня есть сын => may also retain locally`;

export function buildMemoryV3DialogueExtractorRequest(
  input: unknown,
): MemoryV3ExtractorRequest {
  return buildMemoryV3ExtractorRequestForInstruction(
    input,
    MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION,
  );
}
