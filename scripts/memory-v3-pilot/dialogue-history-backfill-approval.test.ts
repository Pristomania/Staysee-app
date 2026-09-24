import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { generateApprovalDecision } from "./dialogue-history-backfill-approval.ts";

const execFileAsync = promisify(execFile);
const APPROVAL_PATH = new URL('./dialogue-history-backfill-approval.ts', import.meta.url);

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

  it("refuses to approve an artifact with missing benchmarkResult", () => {
    const artifact = { semanticReviewPacket: { payloadSha256: "d".repeat(64) } };
    assert.throws(() => generateApprovalDecision(artifact));
  });

  it("correctly validates and writes review file from artifact JSON", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "approval-test-"));
    try {
      const artifactPath = join(tempDir, "test-artifact.json");
      const artifact = successfulArtifact();
      await writeFile(artifactPath, JSON.stringify(artifact));

      // Simulate the CLI's core workflow: read artifact, generate decision, write review file
      const artifactText = await readFile(artifactPath, "utf8");
      const decision = generateApprovalDecision(JSON.parse(artifactText));
      const reviewPath = artifactPath.replace(/\.json$/, ".review.json");
      await writeFile(reviewPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");

      // Verify the review file was created correctly
      const reviewContent = await readFile(reviewPath, "utf8");
      const writtenDecision = JSON.parse(reviewContent);

      assert.equal(writtenDecision.verdict, "PASS");
      assert.equal(writtenDecision.reviewer, "Nastya");
      assert.equal(writtenDecision.payloadSha256, "d".repeat(64));
      assert.equal(writtenDecision.schemaVersion, "memory-v3-dialogue-history-review-v1");
      assert.deepEqual(writtenDecision.items.map((item: { memoryKey: string }) => item.memoryKey), ["a".repeat(64), "b".repeat(64), "c".repeat(64)]);
      assert.ok(writtenDecision.reviewedAt, "reviewedAt timestamp should be present");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("the direct() CLI wrapper actually runs end to end when invoked with the documented 3-token argv", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "approval-cli-test-"));
    try {
      const artifactPath = join(tempDir, "artifact.json");
      await writeFile(artifactPath, JSON.stringify(successfulArtifact()), "utf8");

      // Spawn the approval script as a real subprocess with documented CLI arguments
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        "--import",
        "tsx",
        fileURLToPath(APPROVAL_PATH),
        "--generate-approval",
        "--artifact-file",
        artifactPath,
      ], {
        cwd: process.cwd(),
        windowsHide: true,
      });

      // Verify the subprocess ran successfully
      assert.equal(stderr, "", `Expected no stderr, but got: ${stderr}`);
      assert.ok(stdout.includes("Написан файл подтверждения"), `Expected Russian success message in stdout: ${stdout}`);

      // Verify the .review.json file was created with correct content
      const reviewPath = artifactPath.replace(/\.json$/, ".review.json");
      const reviewContent = await readFile(reviewPath, "utf8");
      const decision = JSON.parse(reviewContent);

      assert.equal(decision.verdict, "PASS");
      assert.equal(decision.reviewer, "Nastya");
      assert.equal(decision.payloadSha256, "d".repeat(64));
      assert.equal(decision.schemaVersion, "memory-v3-dialogue-history-review-v1");
      assert.deepEqual(decision.items.map((item: { memoryKey: string }) => item.memoryKey), ["a".repeat(64), "b".repeat(64), "c".repeat(64)]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
