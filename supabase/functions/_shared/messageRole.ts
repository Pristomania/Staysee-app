/**
 * Normalize message speaker from production (role) and legacy (sender) columns.
 * Default: assistant — never treat ambiguous rows as user-authored.
 */

export type NormalizedMessageRole = "user" | "assistant";

export interface MessageRoleFields {
  sender?: string | null;
  role?: string | null;
}

export function normalizeMessageRole(row: MessageRoleFields): NormalizedMessageRole {
  const sender = row.sender?.trim().toLowerCase();
  if (sender === "user") return "user";
  if (sender === "ai") return "assistant";

  const role = row.role?.trim().toLowerCase();
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";

  return "assistant";
}

export function isUserMessage(row: MessageRoleFields): boolean {
  return normalizeMessageRole(row) === "user";
}

export function isAssistantMessage(row: MessageRoleFields): boolean {
  return normalizeMessageRole(row) === "assistant";
}

/** DB / embeddings sender column: user | ai */
export function toDbSender(row: MessageRoleFields): "user" | "ai" {
  return normalizeMessageRole(row) === "user" ? "user" : "ai";
}
