/** Stable client turn id for one user submit + retries. */

export interface PendingTurn {
  turnId: string;
  content: string;
}

export function createTurnId(): string {
  return crypto.randomUUID();
}

/** Reuse turn id when retrying the same message text; otherwise start a new turn. */
export function resolveTurnId(
  pending: PendingTurn | null,
  content: string,
): string {
  if (pending?.content === content) return pending.turnId;
  return createTurnId();
}
