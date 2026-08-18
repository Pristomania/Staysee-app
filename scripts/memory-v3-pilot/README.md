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
