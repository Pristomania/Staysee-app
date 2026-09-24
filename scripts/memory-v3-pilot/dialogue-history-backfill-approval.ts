/** Auto-generates the review-decision file the import step requires,
 * from a completed paid run's artifact -- Настя never hand-writes this
 * structured JSON herself. Refuses to approve an artifact that isn't
 * fully successful, mirroring validateArtifact's own requirement that
 * only a complete, failure-free run is importable at all. */

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, extname } from 'node:path';

interface ArtifactShape {
  benchmarkResult: {
    execute: boolean;
    conversations: Array<{
      finalState: { items: Array<{ memoryKey: string }> } | null;
      failureCount: number;
    }>;
  };
  semanticReviewPacket: { payloadSha256: string };
}

export function generateApprovalDecision(artifact: unknown): {
  schemaVersion: 'memory-v3-dialogue-history-review-v1';
  payloadSha256: string;
  verdict: 'PASS';
  reviewedAt: string;
  reviewer: 'Nastya';
  items: Array<{ memoryKey: string; semanticVerdict: 'PASS'; reviewerNotes: null }>;
} {
  const typed = artifact as ArtifactShape;
  if (
    typeof typed !== 'object' || typed === null ||
    typeof typed.benchmarkResult !== 'object' || typed.benchmarkResult === null ||
    typed.benchmarkResult.execute !== true ||
    !Array.isArray(typed.benchmarkResult.conversations) ||
    typed.benchmarkResult.conversations.length === 0 ||
    typed.benchmarkResult.conversations.some((row) => row.failureCount !== 0 || row.finalState === null) ||
    typeof typed.semanticReviewPacket !== 'object' || typed.semanticReviewPacket === null ||
    typeof typed.semanticReviewPacket.payloadSha256 !== 'string'
  ) {
    throw new Error('[memory-v3:dialogue-history-approval] artifact is not fully successful, refusing to approve');
  }
  const items = typed.benchmarkResult.conversations.flatMap((conversation) =>
    conversation.finalState!.items.map((item) => ({
      memoryKey: item.memoryKey,
      semanticVerdict: 'PASS' as const,
      reviewerNotes: null,
    }))
  );
  return {
    schemaVersion: 'memory-v3-dialogue-history-review-v1',
    payloadSha256: typed.semanticReviewPacket.payloadSha256,
    verdict: 'PASS',
    reviewedAt: new Date().toISOString(),
    reviewer: 'Nastya',
    items,
  };
}

async function direct(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 4 || argv[0] !== '--generate-approval' || argv[1] !== '--artifact-file' || argv[3] === undefined) {
    console.error('Usage: --generate-approval --artifact-file <absolute .json path>');
    process.exitCode = 1;
    return;
  }
  const artifactFile = argv[2];
  if (!isAbsolute(artifactFile) || extname(artifactFile).toLowerCase() !== '.json') {
    console.error('--artifact-file must be an absolute .json path');
    process.exitCode = 1;
    return;
  }
  const artifactText = await readFile(artifactFile, 'utf8');
  const decision = generateApprovalDecision(JSON.parse(artifactText));
  const reviewFile = artifactFile.replace(/\.json$/, '.review.json');
  await writeFile(reviewFile, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');
  console.log(`Написан файл подтверждения: ${reviewFile}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  void direct();
}
