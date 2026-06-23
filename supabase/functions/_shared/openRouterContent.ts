/**
 * OpenRouter assistant message.content inspection — diagnostic + adapter path.
 * Pure (no Deno imports) for Node/tsx tests.
 */

export type OpenRouterContentRawKind = "string" | "array" | "null" | "other";

export interface OpenRouterContentInspect {
  /** Mirrors staysee-chat callModel today: `content ?? ""` with string type assertion. */
  legacyText: string;
  /** Join all text blocks when content is an array (not used in production path yet). */
  joinedText: string;
  rawKind: OpenRouterContentRawKind;
  blockCount?: number;
  blockTextLengths?: number[];
}

function textFromBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const rec = block as Record<string, unknown>;
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.content === "string") return rec.content;
  return "";
}

/** Join text blocks — safe extraction when providers return ContentPart[]. */
export function joinOpenRouterContentBlocks(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";
  if (!Array.isArray(raw)) return String(raw);
  return raw.map(textFromBlock).join("");
}

/**
 * Legacy adapter: `const content: string = raw ?? ""`.
 * At runtime non-string truthy values (e.g. array) pass through unchanged.
 */
export function legacyOpenRouterContent(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  return raw as unknown as string;
}

export function inspectOpenRouterMessageContent(raw: unknown): OpenRouterContentInspect {
  if (raw == null) {
    return { legacyText: "", joinedText: "", rawKind: "null" };
  }
  if (typeof raw === "string") {
    return { legacyText: raw, joinedText: raw, rawKind: "string" };
  }
  if (Array.isArray(raw)) {
    const blockTextLengths = raw.map((b) => textFromBlock(b).length);
    return {
      legacyText: legacyOpenRouterContent(raw),
      joinedText: joinOpenRouterContentBlocks(raw),
      rawKind: "array",
      blockCount: raw.length,
      blockTextLengths,
    };
  }
  const asString = String(raw);
  return { legacyText: asString, joinedText: asString, rawKind: "other" };
}
