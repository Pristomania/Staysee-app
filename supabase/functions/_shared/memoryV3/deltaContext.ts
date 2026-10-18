/**
 * Delta-mode helpers shared by the dialogue and lifecycle runners (spec
 * 2026-10-13 §1). The first messages of a delta window are earlier context a
 * previous run already analyzed; they inform the extractor but are never new
 * evidence.
 */

import type { MemoryV3Extraction } from "./contract.ts";
import type { MemoryV3ExtractorRequest } from "./extractorRequest.ts";

// Tells the extractor which leading messages are context only, so it does not
// cite them. Applied before the request is measured against the byte cap, so
// the notice can never push a request over it.
export function withMemoryV3EarlierContextNotice(
  request: MemoryV3ExtractorRequest,
  contextCount: number,
): MemoryV3ExtractorRequest {
  if (contextCount <= 0) return request;
  const one = contextCount === 1;
  const notice = `The first ${contextCount} ${one ? "message" : "messages"} of the supplied dialogue ` +
    `${one ? "is" : "are"} earlier context that a previous run already analyzed. ` +
    `Use ${one ? "it" : "them"} only to understand the later messages. ` +
    `Never cite ${one ? "it" : "them"} as evidence: every evidence row must cite one of the later messages.`;
  return { ...request, system: `${request.system}\n${notice}` };
}

// A model that cites a context message anyway must not fail the whole run --
// that would leave the conversation's cursor stuck. Drops every item with any
// evidence outside `citable`, whole, together with all of its evidence rows:
// removing just the offending row could leave an item the contract no longer
// accepts (a recurrence needs two distinct episodes, for instance). Returns
// the same object when nothing was cited outside `citable`.
export function dropMemoryV3ContextCitations(
  extraction: MemoryV3Extraction,
  citable: ReadonlySet<string>,
): MemoryV3Extraction {
  const dropped = new Set(
    extraction.evidence.filter((row) => !citable.has(row.sourceMessageId)).map((row) => row.itemKey),
  );
  if (dropped.size === 0) return extraction;
  return {
    run: extraction.run,
    items: extraction.items.filter((item) => !dropped.has(item.localItemKey)),
    evidence: extraction.evidence.filter((row) => !dropped.has(row.itemKey)),
  };
}
