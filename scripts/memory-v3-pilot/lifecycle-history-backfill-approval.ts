/** Auto-generates the review-decision file the import step requires,
 * from a completed paid run's artifact -- Настя never hand-writes this
 * structured JSON herself. Refuses to approve an artifact that isn't
 * fully successful, mirroring validateArtifact's own requirement that
 * only a complete, failure-free run is importable at all. Mirrors
 * dialogue-history-backfill-approval.ts, adapted for lifecycle's single
 * account-wide finalState instead of dialogue's per-conversation array. */

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, extname } from 'node:path';

interface ArtifactShape {
  benchmarkResult: {
    execute: boolean;
    failureCount: number;
    finalState: { items: Array<{ memoryKey: string }> } | null;
  };
  semanticReviewPacket: { payloadSha256: string };
}

export function generateApprovalDecision(
  artifact: unknown,
  rejectedMemoryKeys: readonly string[] = [],
): {
  schemaVersion: 'memory-v3-lifecycle-history-review-v1';
  payloadSha256: string;
  verdict: 'PASS';
  reviewedAt: string;
  reviewer: 'Nastya';
  items: Array<{
    memoryKey: string;
    semanticVerdict: 'PASS' | 'REJECT';
    reviewerNotes: string | null;
  }>;
} {
  const typed = artifact as ArtifactShape;
  if (
    typeof typed !== 'object' || typed === null ||
    typeof typed.benchmarkResult !== 'object' || typed.benchmarkResult === null ||
    typed.benchmarkResult.execute !== true ||
    typed.benchmarkResult.failureCount !== 0 ||
    typed.benchmarkResult.finalState === null ||
    typeof typed.benchmarkResult.finalState !== 'object' ||
    !Array.isArray(typed.benchmarkResult.finalState.items) ||
    typed.benchmarkResult.finalState.items.length === 0 ||
    typeof typed.semanticReviewPacket !== 'object' || typed.semanticReviewPacket === null ||
    typeof typed.semanticReviewPacket.payloadSha256 !== 'string'
  ) {
    throw new Error('[memory-v3:lifecycle-history-approval] artifact is not fully successful, refusing to approve');
  }
  if (!Array.isArray(rejectedMemoryKeys) ||
    rejectedMemoryKeys.some((memoryKey) => typeof memoryKey !== 'string') ||
    new Set(rejectedMemoryKeys).size !== rejectedMemoryKeys.length) {
    throw new Error('[memory-v3:lifecycle-history-approval] rejected memory keys are invalid');
  }
  const artifactMemoryKeys = new Set(typed.benchmarkResult.finalState.items.map((item) => item.memoryKey));
  if (rejectedMemoryKeys.some((memoryKey) => !artifactMemoryKeys.has(memoryKey))) {
    throw new Error('[memory-v3:lifecycle-history-approval] rejected memory key is not in the artifact');
  }
  const rejected = new Set(rejectedMemoryKeys);
  const items = typed.benchmarkResult.finalState.items.map((item) => ({
    memoryKey: item.memoryKey,
    semanticVerdict: rejected.has(item.memoryKey) ? 'REJECT' as const : 'PASS' as const,
    reviewerNotes: rejected.has(item.memoryKey) ? 'Не одобрено для сквозной памяти' : null,
  }));
  return {
    schemaVersion: 'memory-v3-lifecycle-history-review-v1',
    payloadSha256: typed.semanticReviewPacket.payloadSha256,
    verdict: 'PASS',
    reviewedAt: new Date().toISOString(),
    reviewer: 'Nastya',
    items,
  };
}

async function direct(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 3 || argv.length % 2 !== 1 ||
    argv[0] !== '--generate-approval' || argv[1] !== '--artifact-file' || argv[2] === undefined) {
    console.error('Usage: --generate-approval --artifact-file <absolute .json path> [--reject-memory-key <sha256>]');
    process.exitCode = 1;
    return;
  }
  const artifactFile = argv[2];
  if (!isAbsolute(artifactFile) || extname(artifactFile).toLowerCase() !== '.json') {
    console.error('--artifact-file must be an absolute .json path');
    process.exitCode = 1;
    return;
  }
  const rejectedMemoryKeys: string[] = [];
  for (let index = 3; index < argv.length; index += 2) {
    if (argv[index] !== '--reject-memory-key' || argv[index + 1] === undefined) {
      console.error('Usage: --generate-approval --artifact-file <absolute .json path> [--reject-memory-key <sha256>]');
      process.exitCode = 1;
      return;
    }
    rejectedMemoryKeys.push(argv[index + 1]);
  }
  const artifactText = await readFile(artifactFile, 'utf8');
  const decision = generateApprovalDecision(JSON.parse(artifactText), rejectedMemoryKeys);
  const reviewFile = artifactFile.replace(/\.json$/, '.review.json');
  await writeFile(reviewFile, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');
  console.log(`Написан файл подтверждения: ${reviewFile}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  void direct();
}
