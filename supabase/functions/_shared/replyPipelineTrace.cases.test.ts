/**
 * Reply pipeline trace stage attribution.
 * Run: npx tsx supabase/functions/_shared/replyPipelineTrace.cases.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  beginReplyPipelineTrace,
  getReplyPipelineTraceReport,
  hashReplyContent,
  recordReplyPipelineStage,
} from "./replyPipelineTrace.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function readOutputCeilingGuidance(): string {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "responseBudget.ts"),
    "utf8"
  );
  const m = src.match(
    /export const OUTPUT_TOKEN_CEILING_GUIDANCE\s*=\s*\n?\s*"([^"]+)"/
  );
  if (!m?.[1]) throw new Error("OUTPUT_TOKEN_CEILING_GUIDANCE not found");
  return m[1];
}

// Required test 2 — stage attribution separates ensure vs role enforcement
{
  const prev = process.env.STAYSEE_REPLY_PIPELINE_TRACE;
  process.env.STAYSEE_REPLY_PIPELINE_TRACE = "1";
  (globalThis as { Deno?: { env: { get: (k: string) => string | undefined } } }).Deno = {
    env: { get: (k) => process.env[k] },
  };

  beginReplyPipelineTrace();

  const ensured =
    'Полный ответ после ensure. "Да, страшно. Плачь." Вопрос к пользователю?';
  const roleBounded = ensured; // relational cap disabled — unchanged

  recordReplyPipelineStage("after_ensure_publishable", ensured);
  recordReplyPipelineStage("after_role_bounded_reply", roleBounded);

  const trace = getReplyPipelineTraceReport();
  const ensureStage = trace.find((s) => s.stage === "after_ensure_publishable");
  const roleStage = trace.find((s) => s.stage === "after_role_bounded_reply");

  assert(Boolean(ensureStage), "after_ensure_publishable must be recorded");
  assert(Boolean(roleStage), "after_role_bounded_reply must be recorded");
  assert(
    ensureStage!.contentHash === hashReplyContent(ensured),
    "after_ensure_publishable must reflect ensure output only"
  );
  assert(
    roleStage!.contentHash === hashReplyContent(roleBounded),
    "after_role_bounded_reply must reflect role enforcement output"
  );

  if (prev === undefined) delete process.env.STAYSEE_REPLY_PIPELINE_TRACE;
  else process.env.STAYSEE_REPLY_PIPELINE_TRACE = prev;
  delete (globalThis as { Deno?: unknown }).Deno;

  console.log("PASS: trace stages separate ensure and role enforcement");
}

// Required test 4 — ceiling guidance is minimal technical only
{
  const OUTPUT_TOKEN_CEILING_GUIDANCE = readOutputCeilingGuidance();
  const forbidden = [
    /character/i,
    /1200/,
    /minimal response/i,
    /one question/i,
    /one focus/i,
    /depth.*longer/i,
    /brief.*\d+/i,
    /do not try to fill/i,
    /do not be afraid to be shorter/i,
    /главн(ый|ое) фокус/i,
    /минимальн/i,
  ];

  for (const re of forbidden) {
    assert(!re.test(OUTPUT_TOKEN_CEILING_GUIDANCE), `guidance must not match ${re}`);
  }

  assert(
    OUTPUT_TOKEN_CEILING_GUIDANCE.includes("ceiling is a boundary"),
    "guidance must state ceiling is boundary not target"
  );
  console.log("PASS: OUTPUT_TOKEN_CEILING_GUIDANCE is minimal technical only");
}

console.log("\nAll replyPipelineTrace cases passed.");
