/**
 * Safe stage-by-stage reply pipeline tracing (staging/dev).
 * Logs length, tail, hash — never full message text unless explicitly enabled.
 *
 * Enable: STAYSEE_REPLY_PIPELINE_TRACE=1 on the edge function.
 */

import { isClearlyTruncatedForFinalize, isPublishableReply } from "./completeReply.ts";

export type ReplyPipelineStage =
  | "provider_raw_text"
  | "adapter_extracted_content"
  | "after_auto_continue_merge"
  | "after_polish_merged"
  | "after_ensure_publishable"
  | "after_role_bounded_reply"
  | "before_http_response";

export interface ReplyPipelineTraceEntry {
  stage: ReplyPipelineStage | string;
  contentLength: number;
  tail: string;
  contentHash: string;
  finishReason?: string | null;
  model?: string | null;
  generationStatus?: string | null;
  autoContinueUsed?: boolean;
  finalizeUsed?: boolean;
  publishable?: boolean;
  contactComplete?: boolean;
  /** Non-PII adapter metadata (e.g. rawKind, blockCount). */
  meta?: Record<string, string | number | boolean | null>;
}

const TAIL_CHARS = 120;

let traceActive = false;
const stages: ReplyPipelineTraceEntry[] = [];

export function isReplyPipelineTraceEnabled(): boolean {
  const v =
    typeof Deno !== "undefined"
      ? Deno.env.get("STAYSEE_REPLY_PIPELINE_TRACE")
      : undefined;
  return v === "1" || v === "true";
}

/** FNV-1a 32-bit — stable, sync, no crypto dependency. */
export function hashReplyContent(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function tailReplyContent(text: string, maxChars = TAIL_CHARS): string {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(-maxChars);
}

function contentForTrace(text: unknown): string {
  if (text == null) return "";
  if (typeof text === "string") return text;
  if (Array.isArray(text)) {
    return text
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string") {
          return (b as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return String(text);
}

function sampleContentForTrace(text: string, max = 200): { head: string; tail: string } | null {
  const v =
    typeof Deno !== "undefined"
      ? Deno.env.get("STAYSEE_REPLY_PIPELINE_TRACE_SAMPLES")
      : undefined;
  if (v !== "1" && v !== "true") return null;
  const body = contentForTrace(text);
  if (!body) return { head: "", tail: "" };
  return {
    head: body.slice(0, max),
    tail: body.slice(-max),
  };
}

export function beginReplyPipelineTrace(): void {
  traceActive = isReplyPipelineTraceEnabled();
  stages.length = 0;
}

export function recordReplyPipelineStage(
  stage: ReplyPipelineTraceEntry["stage"],
  content: unknown,
  opts?: {
    finishReason?: string | null;
    model?: string | null;
    generationStatus?: string | null;
    autoContinueUsed?: boolean;
    finalizeUsed?: boolean;
    publishable?: boolean;
    contactComplete?: boolean;
    meta?: Record<string, string | number | boolean | null>;
  }
): void {
  if (!traceActive) return;

  const body = contentForTrace(content);
  const sample = sampleContentForTrace(body);
  const entry: ReplyPipelineTraceEntry = {
    stage,
    contentLength: body.length,
    tail: tailReplyContent(body),
    contentHash: hashReplyContent(body),
    finishReason: opts?.finishReason ?? null,
    model: opts?.model ?? null,
    generationStatus: opts?.generationStatus ?? null,
    autoContinueUsed: opts?.autoContinueUsed ?? false,
    finalizeUsed: opts?.finalizeUsed ?? false,
    publishable: opts?.publishable ?? isPublishableReply(body),
    contactComplete: opts?.contactComplete,
    meta: {
      ...opts?.meta,
      ...(sample ? { sampleHead: sample.head, sampleTail: sample.tail } : {}),
      ...(sample && body.length <= 2000
        ? { investigateFullText: body }
        : {}),
    },
  };

  stages.push(entry);
  console.log(`[staysee-chat] reply_pipeline_trace ${JSON.stringify(entry)}`);
}

export function getReplyPipelineTraceReport(): ReplyPipelineTraceEntry[] {
  return [...stages];
}

export function comparePipelineTails(
  a: ReplyPipelineTraceEntry | undefined,
  b: ReplyPipelineTraceEntry | undefined
): { sameHash: boolean; sameTail: boolean; lengthDelta: number } {
  return {
    sameHash: Boolean(a && b && a.contentHash === b.contentHash),
    sameTail: Boolean(a && b && a.tail === b.tail),
    lengthDelta: (b?.contentLength ?? 0) - (a?.contentLength ?? 0),
  };
}

/** Heuristic for diagnostic reports — not a publishability gate. */
export function isContactSuspicious(text: string): boolean {
  const body = text.trim();
  if (!body) return true;

  const dq = (body.match(/"/g) ?? []).length;
  if (dq % 2 === 1) return true;

  const openGuillemets = (body.match(/«/g) ?? []).length;
  const closeGuillemets = (body.match(/»/g) ?? []).length;
  if (openGuillemets !== closeGuillemets) return true;

  if (/\([^)]*$/.test(body) || /\[[^\]]*$/.test(body)) return true;

  if (!isPublishableReply(body)) return true;
  if (isClearlyTruncatedForFinalize(body)) return true;
  return false;
}
