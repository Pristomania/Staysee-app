/** Formats a completed dialogue history backfill run's result as plain
 * Russian text Настя can actually read -- grouped by conversation, each
 * surviving item's claim and topic label. Every conversation gets
 * reprocessed, including ones that already had live data (Настя's
 * explicit choice, 2026-09-24) -- so this report must say plainly, per
 * conversation, whether its existing records get replaced or it started
 * empty, never leave that ambiguous. Pure formatting over data the JSON
 * result already has; no new extraction logic, no model calls. */

const DIALOGUE_TOPIC_LABELS: Record<string, string> = {
  person: 'Люди',
  fact: 'Факты',
  preference: 'Предпочтения общения',
};

interface ReportItem {
  claim: string;
  topic: string | null;
}

interface ReportConversation {
  conversationId: string;
  finalState: { items: ReportItem[] } | null;
  failureCount: number;
  expectedStateRevision: number;
}

export function buildReadableReport(input: {
  benchmarkResult: { conversations: ReportConversation[] };
}): string {
  const lines: string[] = [];
  const succeeded = input.benchmarkResult.conversations.filter(
    (row) => row.failureCount === 0 && row.finalState !== null,
  );
  const failed = input.benchmarkResult.conversations.filter(
    (row) => row.failureCount !== 0 || row.finalState === null,
  );
  const replacedCount = succeeded.filter((row) => row.expectedStateRevision > 0).length;

  lines.push(`Разобрано диалогов: ${succeeded.length}`);
  if (replacedCount > 0) {
    lines.push(`Из них с заменой уже накопленной памяти: ${replacedCount}`);
  }
  if (failed.length > 0) lines.push(`Не удалось разобрать: ${failed.length}`);
  lines.push('');

  for (const conversation of succeeded) {
    const status = conversation.expectedStateRevision > 0
      ? '(в этом диалоге уже была своя память -- она заменена этим разбором)'
      : '(диалог был пустым)';
    lines.push(`Диалог ${conversation.conversationId} ${status}:`);
    if (conversation.finalState!.items.length === 0) {
      lines.push('  (ничего устойчивого не найдено)');
    }
    for (const item of conversation.finalState!.items) {
      const label = item.topic !== null ? (DIALOGUE_TOPIC_LABELS[item.topic] ?? item.topic) : 'без темы';
      lines.push(`  [${label}] ${item.claim}`);
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push('Диалоги, которые не удалось разобрать:');
    for (const conversation of failed) {
      lines.push(`  ${conversation.conversationId}`);
    }
  }

  return lines.join('\n');
}
