import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateApprovalDecision } from "./dialogue-history-backfill-approval.ts";

function successfulArtifact() {
  return {
    benchmarkResult: {
      execute: true,
      conversations: [
        { finalState: { items: [{ memoryKey: "a".repeat(64) }, { memoryKey: "b".repeat(64) }] }, failureCount: 0 },
        { finalState: { items: [{ memoryKey: "c".repeat(64) }] }, failureCount: 0 },
      ],
    },
    semanticReviewPacket: { payloadSha256: "d".repeat(64) },
  };
}

describe("dialogue history backfill approval generator", () => {
  it("generates a PASS decision covering every item from every conversation, in order", () => {
    const decision = generateApprovalDecision(successfulArtifact());
    assert.equal(decision.verdict, "PASS");
    assert.equal(decision.reviewer, "Nastya");
    assert.equal(decision.payloadSha256, "d".repeat(64));
    assert.deepEqual(decision.items.map((item) => item.memoryKey), ["a".repeat(64), "b".repeat(64), "c".repeat(64)]);
    assert.ok(decision.items.every((item) => item.semanticVerdict === "PASS" && item.reviewerNotes === null));
  });

  it("refuses to approve an artifact where any conversation has a nonzero failureCount", () => {
    const artifact = successfulArtifact();
    artifact.benchmarkResult.conversations[0].failureCount = 1;
    assert.throws(() => generateApprovalDecision(artifact));
  });

  it("refuses to approve an artifact where any conversation's finalState is null", () => {
    const artifact = successfulArtifact();
    (artifact.benchmarkResult.conversations[1] as { finalState: unknown }).finalState = null;
    assert.throws(() => generateApprovalDecision(artifact));
  });

  it("refuses to approve a dry-run (execute: false) artifact", () => {
    const artifact = successfulArtifact();
    artifact.benchmarkResult.execute = false;
    assert.throws(() => generateApprovalDecision(artifact));
  });
});
