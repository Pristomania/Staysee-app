/**
 * Source architecture regression for staysee-chat atomic quota wiring.
 * Real concurrency is confirmed by staging parallel smoke.
 * Disconnect accounting is finally confirmed by handler/staging test.
 *
 * Analyzes only the Deno.serve handler body (comments stripped).
 *
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/stayseeChatAtomicQuotaWiring.cases.test.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function allIndexes(src: string, re: RegExp): number[] {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = global.exec(src)) !== null) {
    out.push(m.index);
  }
  return out;
}

const PROVIDER_SEAMS = [
  "runConversationSummaryRefresh(",
  "callModel(",
  "callModelStructured(",
] as const;

/** Extract `{ ... }` starting at openBraceIdx using balanced-bracket scan. */
function extractBalancedBraceBlock(
  src: string,
  openBraceIdx: number,
): { start: number; end: number; text: string } {
  assert(src[openBraceIdx] === "{", `expected '{' at ${openBraceIdx}`);
  let depth = 0;
  for (let i = openBraceIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { start: openBraceIdx, end: i, text: src.slice(openBraceIdx, i + 1) };
      }
    }
  }
  throw new Error("unbalanced '{' while extracting deny block");
}

function firstProviderSeamIndex(src: string, from = 0): number {
  let best = Number.POSITIVE_INFINITY;
  for (const seam of PROVIDER_SEAMS) {
    const escaped = seam.replace(/[()]/g, "\\$&");
    const rel = src.slice(from).search(new RegExp(`\\b${escaped}`));
    if (rel >= 0) best = Math.min(best, from + rel);
  }
  return best;
}

function expectValidationFailure(source: string, label: string): void {
  let threw = false;
  let message = "";
  try {
    validateAtomicQuotaWiring(source);
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  assert(threw, `expected validation failure for: ${label}`);
  console.log(`✓ mutation rejected (${label}): ${message}`);
}

export function validateAtomicQuotaWiring(source: string): void {
  const noComments = stripComments(source);
  const servePos = noComments.indexOf("Deno.serve(");
  assert(servePos >= 0, "Deno.serve( must exist");
  const handler = noComments.slice(servePos);

  // ── 1. Preliminary checkRateLimit ─────────────────────────────────────────

  assert(
    /checkRateLimit\s*\(/.test(handler),
    "handler must contain preliminary checkRateLimit(",
  );

  // ── 2. Authoritative reserve: exactly one reserveAiRequest ────────────────

  const reserveIndexes = allIndexes(handler, /\breserveAiRequest\s*\(/);
  assert(
    reserveIndexes.length === 1,
    `handler must contain exactly one reserveAiRequest( call, got ${reserveIndexes.length}`,
  );
  const reservePos = reserveIndexes[0];

  const prelimPos = handler.search(/checkRateLimit\s*\(/);
  assert(
    prelimPos >= 0 && prelimPos < reservePos,
    "preliminary checkRateLimit must appear before atomic reserve",
  );

  // ── 3. Free guards before reserve ─────────────────────────────────────────

  const beforeReserve = handler.slice(0, reservePos);
  assert(
    /safety\.immediateResponse/.test(beforeReserve),
    "safety immediate-response check must appear before atomic reserve",
  );
  assert(
    /detectExplicitPromptAttackHardStop|explicitPromptAttackStop/.test(beforeReserve),
    "explicit prompt-attack hard-stop must appear before atomic reserve",
  );

  // ── 4. All provider-backed seams after reserve (eager summary first) ──────

  const firstSummaryIdx = handler.search(/\brunConversationSummaryRefresh\s*\(/);
  assert(firstSummaryIdx >= 0, "runConversationSummaryRefresh( must exist in handler");
  assert(
    firstSummaryIdx > reservePos,
    "atomic reserve must precede eager provider-backed summary refresh",
  );

  for (const seam of PROVIDER_SEAMS) {
    const escaped = seam.replace(/[()]/g, "\\$&");
    const indexes = allIndexes(handler, new RegExp(`\\b${escaped}`));
    for (const idx of indexes) {
      assert(
        idx > reservePos,
        `atomic reserve must precede provider-backed seam ${seam} at offset ${idx}`,
      );
    }
  }

  // ── 5. Atomic deny: full balanced block, no provider seams inside ─────────

  const denyIfRe = /if\s*\(\s*!reserveResult\.allowed\s*\)/;
  const denyIfMatch = denyIfRe.exec(handler);
  assert(denyIfMatch !== null, "atomic deny if (!reserveResult.allowed) must appear");
  assert(
    denyIfMatch.index > reservePos,
    "atomic deny if (!reserveResult.allowed) must appear after reserve",
  );

  let braceIdx = denyIfMatch.index + denyIfMatch[0].length;
  while (braceIdx < handler.length && /\s/.test(handler[braceIdx]!)) braceIdx++;
  assert(
    handler[braceIdx] === "{",
    "atomic deny if (!reserveResult.allowed) must open a { ... } block",
  );

  const denyBlock = extractBalancedBraceBlock(handler, braceIdx);
  assert(
    /mapQuotaDenyResponse\s*\(/.test(denyBlock.text),
    "atomic deny block must contain mapQuotaDenyResponse",
  );
  assert(
    /return\s+new\s+Response/.test(denyBlock.text),
    "atomic deny block must contain return new Response",
  );

  for (const seam of PROVIDER_SEAMS) {
    const escaped = seam.replace(/[()]/g, "\\$&");
    assert(
      !new RegExp(`\\b${escaped}`).test(denyBlock.text),
      `atomic deny block must not contain provider seam ${seam}`,
    );
  }

  const firstProviderPos = firstProviderSeamIndex(handler, reservePos);
  assert(
    Number.isFinite(firstProviderPos),
    "at least one provider-backed seam must exist after reserve",
  );
  assert(
    denyBlock.end < firstProviderPos,
    "atomic deny block end must be before the first provider-backed seam",
  );

  // ── 6. Disconnect-independent token accounting ────────────────────────────

  assert(
    !/\bincrementUsage\s*\(/.test(handler),
    "incrementUsage( must be absent from handler",
  );

  const recordIndexes = allIndexes(handler, /\brecordTokenUsage\s*\(/);
  assert(
    recordIndexes.length === 1,
    `handler must contain exactly one recordTokenUsage( call, got ${recordIndexes.length}`,
  );
  const recordPos = recordIndexes[0];

  const clientConnectedBlock = handler.search(/if\s*\(\s*userId\s*&&\s*clientConnected\s*\)/);
  assert(clientConnectedBlock >= 0, "if (userId && clientConnected) block must exist");
  assert(
    recordPos < clientConnectedBlock,
    "recordTokenUsage must appear before if (userId && clientConnected)",
  );

  const accountingRe =
    /const\s+totalTokens\s*=\s*[^;]+;([\s\S]*?)EdgeRuntime\.waitUntil\(\s*recordTokenUsage\(\s*quotaServiceClient\s*,\s*userId\s*,\s*totalTokens\s*,?\s*\)\s*,?\s*\)/;
  const accountingMatch = accountingRe.exec(handler);
  assert(
    accountingMatch !== null,
    "must call EdgeRuntime.waitUntil(recordTokenUsage(quotaServiceClient, userId, totalTokens)) immediately after totalTokens",
  );

  const gap = accountingMatch[1] ?? "";
  assert(
    /^\s*$/.test(gap),
    "between totalTokens and EdgeRuntime.waitUntil(recordTokenUsage...) only whitespace is allowed",
  );
  assert(
    !/\bif\b|\?|&&|clientConnected|signal\.aborted|req\.signal/.test(gap),
    "recordTokenUsage must not be gated by if/ternary/&&/clientConnected/req.signal.aborted between totalTokens and waitUntil",
  );
  assert(
    accountingMatch.index! + accountingMatch[0].indexOf("recordTokenUsage") === recordPos,
    "the only recordTokenUsage must be the direct EdgeRuntime.waitUntil argument after totalTokens",
  );
}

// ── Real handler ──────────────────────────────────────────────────────────────

const raw = readFileSync(resolve("supabase/functions/staysee-chat/index.ts"), "utf8");
validateAtomicQuotaWiring(raw);
console.log("✓ real handler passes validateAtomicQuotaWiring");

// ── Mutation A: provider seam inside atomic deny before return ────────────────

{
  const denyOpen = 'if (!reserveResult.allowed) {';
  const denyAt = raw.indexOf(denyOpen);
  assert(denyAt >= 0, "mutation A setup: deny open must exist in source");
  const insertAt = denyAt + denyOpen.length;
  const mutatedA =
    raw.slice(0, insertAt) +
    "\n      callModel(providerKey, config, [], \"\", 1);\n" +
    raw.slice(insertAt);
  expectValidationFailure(
    mutatedA,
    "provider callModel inside atomic deny before return",
  );
}

// ── Mutation B: recordTokenUsage wrapped in abort guard ───────────────────────

{
  const target =
    /EdgeRuntime\.waitUntil\(\s*recordTokenUsage\(\s*quotaServiceClient\s*,\s*userId\s*,\s*totalTokens\s*,?\s*\)\s*,?\s*\)\s*;/;
  assert(target.test(raw), "mutation B setup: unconditional waitUntil(recordTokenUsage) must exist");
  const mutatedB = raw.replace(
    target,
    `if (!req.signal.aborted) {
      EdgeRuntime.waitUntil(
        recordTokenUsage(quotaServiceClient, userId, totalTokens),
      );
    }`,
  );
  assert(mutatedB !== raw, "mutation B setup: source must change");
  expectValidationFailure(
    mutatedB,
    "recordTokenUsage wrapped in if (!req.signal.aborted)",
  );
}

console.log("=== stayseeChatAtomicQuotaWiring.cases.test.ts OK ===");
