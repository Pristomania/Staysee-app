# StaySEE Memory V3 — offline pilot (stage 1)

Epistemic contract for offline memory extractors. **Not** wired into the app, database, or live runtime.

## Purpose

Define and test a strict contract so extractors can distinguish:

| Kind | Meaning |
|------|---------|
| `event` | Biographical event |
| `recurrence` | Pattern supported by **distinct user episodes** |
| `hypothesis` | Psychological hypothesis — not an established fact |

Assistant (and system) messages are **never** supporting evidence for events, recurrences, or hypotheses. Diagnoses, clinical labels, attachment-style traits, and chain-of-thought must not appear in extraction payloads.

## Extraction shape

```json
{
  "run": { "caseId": "...", "extractorVersion": "..." },
  "items": [ /* event | recurrence | hypothesis */ ],
  "evidence": [ /* links items to fixture message ids */ ]
}
```

- **Items** hold claims, scope, optional `eventTimeStart` / `eventTimeEnd`, status, sensitivity.
- **Evidence** holds `sourceMessageId`, `episodeKey`, `relation`, `provenanceRole`, and `mentionTime`.

### Dates and times

Calendar components are checked strictly (no `Date.parse` rollover). Impossible values such as `2023-02-29` or `2024-13-01` are rejected.

- **`createdAt`** (messages) and **`mentionTime`** (evidence): must be an unambiguous instant — ISO datetime with a `T` separator and a timezone (`Z` or explicit `±HH:MM`). A space instead of `T` is rejected. The maximum allowed offset is `±14:00`; values from `±14:01` through `±14:59` are rejected.
- **`eventTimeStart` / `eventTimeEnd`**: either a strict calendar date `YYYY-MM-DD`, or the same strict ISO datetime with timezone as above.

### `eventTime` vs `mentionTime`

- **`eventTime*`** (on the item): when the life event happened (or a range), if known.
- **`mentionTime`** (on evidence only): when it was mentioned in the dialogue. Must not appear on items.

### Case alignment

When `validateExtraction(extraction, caseData)` is given `caseData`, `extraction.run.caseId` must equal `caseData.caseId`. Matching message ids alone is not enough. Every `caseData` argument is always run through `validateCase` first; a caller-supplied `_messageById` does not bypass validation.

An item does not exist without related **user** evidence. The required relation depends on status:

- `event` `active` → `supports`; `corrected` → `corrects`; `rejected` → `rejects`
- `recurrence` `candidate` / `active` → `supports` from at least two distinct user `episodeKey`s; `stale` → `contradicts`; `rejected` → `rejects`
- `hypothesis` `candidate` / `supported` → `supports`; `stale` → `contradicts`; `rejected` → `rejects`

Assistant and system messages are never evidence for any relation.

### Recurrence vs retelling one episode

A recurrence that is `candidate` or `active` needs at least **two** `supports` relations from **user** evidence with **two different** `episodeKey` values. Two messages about the same episode (same `episodeKey`) do not create a recurrence.

Evidence is unique by `(itemKey, sourceMessageId, relation)`. `episodeKey` is metadata, not part of that identity: one source message cannot stand in for two different recurrence episodes.

In gold recurrences, `supportMessageIds` must be unique within that recurrence. When `episodeKeys` is present:

- `supportMessageIds[i]` corresponds to `episodeKeys[i]` (same index);
- both arrays must have the same length;
- each `episodeKey` must be a non-empty string;
- at least **two distinct** `episodeKey` values must be paired with messages whose `role` is `user`;
- assistant/system supports do not count as user episodes.

If `episodeKeys` is omitted, the older rule still applies: a recurrence supported only by assistant/system messages is rejected. Episode keys are never invented automatically.

### Hypothesis

A hypothesis must include a non-empty **`alternative`** (another plausible explanation or “unknown”). It stays a hypothesis in status (`candidate` / `supported` / `stale` / `rejected`) — never an event fact.

## Privacy boundary

- `sourceMessageId` in this pilot refers only to **local fixture** message ids inside offline cases.
- These are **not** production `messages.id` values.
- Real user dialogues are not used here.
- Raw fixtures stay local.
- Future reports should include only case IDs, metrics, and normalized claims — not raw chat text.

## API

From `contracts.mjs`:

- `ITEM_KINDS`, `EVIDENCE_RELATIONS`
- `validateCase(value)`
- `validateExtraction(value, caseData?)`
- `makeRunKey({ caseId, extractorVersion })`
- `makeLocalItemKey(item, index)`

## Run tests

```bash
node --test scripts/memory-v3-pilot/contracts.cases.test.mjs
node --test scripts/memory-v3-pilot/memory-v3-dataset.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
```

## Russian golden dataset (stage 2)

`memory-v3-ru-golden.v1.json` is a synthetic-only offline benchmark. It contains 24 Russian-language cases, balanced across six categories: biographical events, genuine multi-episode recurrences, explicitly uncertain psychological hypotheses, user corrections, counterexamples that require abstention, and safety/privacy boundaries.

The dataset deliberately includes long time spans, repeated retellings of one episode, assistant-invented biography, third-party sensitive information, rejected interpretations, and hypotheses with counterevidence. `mustNotRemember` is an evaluator target: it records claims a memory system must abstain from storing as user facts. It is not extractor output and must never be treated as positive evidence.

All message ids are local fixture ids. All dialogue is synthetic; no production conversations, user ids, provider calls, or database access are involved.

## Structural evaluator (stage 3)

`evaluator.mjs` scores extractor output without a model, network access, database, or live runtime. It exposes:

- `evaluateCase(caseData, extraction)`
- `evaluateDataset(dataset, extractions, options?)`
- `renderMarkdownReport(report)`

Items are matched only within the same kind and only when predicted and gold items share at least one positive `supports` message. The deterministic assignment maximizes the number of matches, then relation-aware evidence F1. The report includes item precision/recall/F1, evidence metrics by relation, exact event-time accuracy, exact recurrence-episode accuracy, and abstention for cases whose positive gold set is completely empty.

This stage is intentionally **structural**, not a semantic judge:

- paraphrase meaning and psychological correctness are `NOT EVALUATED`;
- `mustNotRemember` claims cannot be detected by meaning in mixed cases and are `NOT EVALUATED`;
- “gold-empty abstention accuracy” covers only cases with no positive gold items at all;
- a structurally perfect score must not be presented as overall memory quality.

The JSON result and Markdown rendering contain case IDs and metrics, not raw dialogue text. Semantic and forbidden-claim evaluation belongs to a later explicit judge/manual-review stage.

## Offline extractor core (stage 4)

Provider-neutral offline extraction. An injected adapter is called once; the core does not select a model, read `.env`, call a network/provider API, or touch a database.

Public APIs:

- `buildExtractorRequest(caseData)` from `extractor-prompt.mjs` — validates the case and returns `{ system, input }` with only `caseId` and four-field messages. Golden fields never enter the adapter request.
- `extractCase(caseData, modelAdapter, { extractorVersion })` from `extractor-core.mjs` — calls `modelAdapter(request)` exactly once, parses a JSON string or plain object, allowlists adapter fields, derives trusted run/scope/provenance, and returns `validateExtraction(result, caseData)`.

Adapter contract: return `{ items, evidence }` only. Items use response-local `itemRef`; evidence points at the same `itemRef`. The core deletes `itemRef` and creates `localItemKey` / evidence `itemKey`. The adapter must not supply `run`, `scope`, `conversationId`, `provenanceRole`, or `mentionTime`. Adapter objects must be JSON-data-only: `Object.prototype` or `null` prototype, expected enumerable string keys, data descriptors only. Accessors, symbol keys, and non-enumerable properties are rejected. An item is rejected unless it has the user evidence relation required by its status.

Failure behavior: one call, no retry, no repair, no dropping of invalid items. Errors use a stable prefix:

- `[memory-v3:adapter]` — adapter throw/reject
- `[memory-v3:parse]` — malformed JSON
- `[memory-v3:shape]` — invalid case, options, adapter, or response shape
- `[memory-v3:contract]` — normalized extraction failed the epistemic contract

Assistant and system messages are context only. They are never Memory V3 evidence for `supports`, `contradicts`, `corrects`, or `rejects`.

This stage does not score semantic quality. Structural checks and the existing evaluator remain separate from paraphrase or psychological correctness.

## OpenRouter adapter and preflight budget (Task 3A)

Offline OpenRouter **boundary** only. The adapter is provider-neutral relative to Memory V3 core: it turns `buildExtractorRequest` output into one OpenRouter chat-completions envelope and returns `choices[0].message.content` as a string. `extractor-core` still owns parse, allowlisting, and `validateExtraction`.

- Transport is a **required injected dependency**. There is no `globalThis.fetch` fallback, so the network is technically impossible unless a caller supplies a transport.
- One extractor case is **at most one** transport call. The adapter does not retry, heal responses, stream, select a model, or fall back to another provider.
- The request uses strict structured output (`response_format.type = json_schema`, `strict: true`, `additionalProperties: false`). The option `maxOutputTokens` is provider-neutral; the OpenRouter body field is `max_completion_tokens`. `max_tokens` is not sent. Provider routing is locked to `allow_fallbacks: false`, `require_parameters: true`, `data_collection: "deny"`, and `zdr: true`.
- Optional `reasoningEffort` is allowlisted as `none | low | medium | high`. Unset and `"none"` omit both `reasoning` and `reasoning_effort`. `"low" | "medium" | "high"` send `reasoning: { effort }` only; `reasoning_effort` is never sent.
- The adapter projects one trusted content path from a JSON-data-only response: `choices[0].message.content`. Official OpenRouter metadata (`id`, `usage`, `model`, and similar) is ignored, not copied. Only `finish_reason: "stop"` is accepted.
- `calculateBudgetCeiling` / `assertBudgetGate` compute a **configured worst-case ceiling** from case count × token caps × dated USD/million prices. That is not a promise of actual billing.
- The pricing snapshot used in tests is dated `2026-08-19` for `openai/gpt-5.6-luna`, using the **maximum** observed price across the allowed ZDR endpoints: `$0.22/M` input and `$1.32/M` output. One-case conservative ceiling (16384 input + 1200 output) is `$0.00518848`. Live-smoke hard max is `$0.0055`.
- Three authorized live-smokes returned `openrouter_http_404` while the adapter sent `max_tokens`. After switching to `max_completion_tokens`, one live POST reached HTTP 200 and stopped on `openrouter_refusal`. That code was **ambiguous**: the old adapter rejected the mere presence of a `refusal` key, including official `refusal: null`. Routing/404 is fixed. Privacy locks were not weakened. Actual usage/cost of those calls is unavailable.
- Live transport, `.env` loading, paid benchmark, and a results file are **not** part of this stage.

## HTTP fetch transport and offline runner (Task 3B)

Tested wiring only. Still **no** live OpenRouter call, `.env` loader, CLI, or results file.

- `createOpenRouterFetchTransport({ fetchImpl, timeoutMs, maxResponseBytes, setTimeoutImpl?, clearTimeoutImpl? })` is the HTTP boundary. `fetchImpl` is required; there is no `globalThis.fetch` fallback. Timer helpers are optional **together**; omit both to use native `setTimeout` / `clearTimeout`.
- One transport request becomes one `fetchImpl` call: `POST` to `https://openrouter.ai/api/v1/chat/completions`, JSON-serialized body, `AbortSignal` timeout covering `fetchImpl`, `response.text()`, the byte check, and JSON parse, and a byte cap on the HTTP text body. No retry. The timer is cleared once in an outer `finally`.
- The fetch layer returns `{ status, body }` for the existing OpenRouter adapter. It does not parse Memory V3 items; `extractor-core` still owns that. Native Fetch `Response` status/`text` may live on the prototype; the transport does not treat the HTTP response as a JSON-data-only plain object.
- `runOfflineBenchmark({ dataset, modelAdapter, budget, extractorVersion, maxPromptRequestBytesPerCase })` is extraction-only. The structural evaluator stays a **separate** layer. Live CLI, `.env`, and provider calls are not part of this stage.
- All preflight runs before the first adapter call: JSON-data-only options/dataset/cases, dense non-empty cases, `validateCase`, unique `caseId`, `budget.caseCount === dataset.cases.length`, `buildExtractorRequest` byte cap via `maxPromptRequestBytesPerCase`, then `assertBudgetGate`.
- Cases run sequentially with concurrency **1**. A case failure is recorded as `{ caseId, stage }` and the runner continues without retry. Raw errors, dialogue, gold, title, category, and messages are not returned.
- `budget.caseCount` must equal `dataset.cases.length`. The runner does not read the filesystem or provider env. Prompt request bytes are a size cap, not tokens and not actual billing.

## One-case live smoke (Task 3C)

Allowlisted CLI for one synthetic case. Fake-fetch unit tests cover the path; a live POST requires `--execute-one-paid-request`.

- Case `memv3-ru-counterexample-04`, model `openai/gpt-5.6-luna`, option `maxOutputTokens` 1200 mapped to HTTP `max_completion_tokens`. Internal `reasoningEffort` is `"none"`; the HTTP body omits `reasoning`, `reasoning_effort`, and `max_tokens`.
- Provider lock is unchanged: `allow_fallbacks: false`, `require_parameters: true`, `data_collection: "deny"`, `zdr: true`. No retry, fallback, or repair.
- Dated pricing `2026-08-19`, maximum across allowed ZDR endpoints: `$0.22/M` input, `$1.32/M` output. Configured one-case ceiling `$0.00518848`; CLI max budget `$0.0055`.
- Trusted `diagnosticCode` is projected from branded transport/adapter errors. `extractCase` still wraps adapter throws as stage `adapter`.
- The adapter projects `choices[0].message.content`. Absent `refusal` and `refusal: null` are accepted. A refusal string (including `""`) is `openrouter_refusal` without copying the value into the public error. Any other refusal type is `openrouter_response_invalid_shape`. Getters/accessors are not executed.
- Three authorized live POSTs returned `openrouter_http_404` because the request used `max_tokens`. A later live POST after the `max_completion_tokens` fix reached HTTP 200 and reported `openrouter_refusal`; that did **not** prove a model refusal, because the adapter then rejected nullable `refusal`. After the nullable-refusal fix, one allowlisted live-smoke completed with exactly one provider HTTP call and no retry: one event and one user `supports` evidence matched the synthetic gold case with structural item/evidence F1 `1.0`. This proves the one-case pipeline, not semantic quality or full-dataset quality. Actual usage/cost is unavailable.
