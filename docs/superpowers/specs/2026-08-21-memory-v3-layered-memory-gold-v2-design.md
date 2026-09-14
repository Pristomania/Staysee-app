# Memory V3 Layered Memory + Typed Evidence + Gold V2 Design

Date: 2026-08-21
Branch: `codex/memory-v3-pilot`
HEAD at approval: `60180507796820deceff0aef9bc3ce00a2062444`
Status: **approved design; not implemented**
Supersedes for future work: one-kind closed-world reading of `memory-v3-ru-golden.v1.json`
Does not modify: current Memory V3 modules, tests, README, or golden v1

## Decision

**ADOPT_LAYERED_MEMORY_AND_TYPED_EVIDENCE_WITH_OPEN_WORLD_GOLD**

StaySEE Memory V3 keeps three item kinds and stops treating them as a forced single-layer choice. A dialogue may yield several items of different kinds when each item is a distinct epistemic layer, independently useful in a future conversation, not a paraphrase of another item, and admitted on its own gate.

Every adapter evidence row in V2 carries a typed `supportType` field. Only recurrence `supports` may use a non-null type. Only an `episode_observation` is a real episode. Pattern confirmation and scope boundaries must not be forced onto a fake `episodeKey`.

Gold v2 is authored as an open world of valid layers (`required` plus `acceptable`) and scored closed against that union. In this document `acceptable` means разрешённый, но необязательный: emitting a matching `acceptable` item is not a false positive; omitting it is not a false negative. Unlisted extras remain structural false positives. Gold v1 stays frozen.

The extractor is not required to emit every valid layer.

## Goal

Specify the next Memory V3 contract so long-term memory can store, at the same time:

1. a biographical event or explicit user decision;
2. an observed behavioural recurrence across at least two real episodes;
3. a cautious psychological hypothesis with an alternative;
4. a correction or rejection of a previous interpretation;
5. a meta confirmation of a pattern that is not itself an episode.

This stage is design only. It does not change runtime code, tests, README, or `memory-v3-ru-golden.v1.json`.

## Scope

This document defines:

- layered-kind policy and admission;
- typed evidence wire format;
- correction lifecycle;
- evaluator v2 matching and gold v2 scoring;
- compatibility with the current pilot.

It does not select a provider, authorize a paid benchmark, persist memory, or integrate with StaySEE production.

## Non-goals

- Do not introduce kind `state` in this stage.
- Do not invent a new evidence `relation`. Existing relations remain `supports | contradicts | corrects | rejects`.
- Do not automatically emit `event + recurrence + hypothesis` for every dialogue or every episode.
- Do not treat aggregate F1 from the six-case live run as a quality target or as proof of the new contract.
- Do not edit `scripts/memory-v3-pilot/**` in the same change that only adds this spec.
- Do not read `.env`, call OpenRouter, run live-smoke, or run a paid benchmark to complete this design.
- Do not commit, push, open a PR, merge, or deploy as part of writing this spec.
- Do not wire Memory V3 into the app, database, or production runtime.

## Current contract (frozen behaviour)

The live pilot on this branch still implements a **valid but one-layer-scoring** system.

`contracts.mjs` already allows mixed kinds in one extraction. `ITEM_KINDS` is `event | recurrence | hypothesis`. Test fixture `minimalCase` in `contracts.cases.test.mjs` even places all three kinds in one gold object. There is no contract rule “an extraction may contain only one kind”.

What makes kinds exclusive in practice:

- `memory-v3-ru-golden.v1.json` almost always fills a single gold list per case (category `recurrence` has empty `events`/`hypotheses`; category `hypothesis` has empty `recurrences`; `correction-04` has empty `events`).
- `evaluator.mjs` matches items only within the same kind and only when predicted and gold share at least one `supports` message. A justified extra kind is therefore an unmatched extra item.
- `validateEvidence` requires `episodeKey` as a non-empty string on **every** evidence row, including recurrence `supports` that are not episode narratives.
- `assertRecurrenceEvidence` counts distinct `episodeKey` values over **all** user `supports`, so a pattern-confirmation message is forced to impersonate an episode.
- Recurrence episode accuracy compares partition equivalence over **all** gold `supportMessageIds`, including non-episode supports.

Extractor adapter evidence fields today are exactly `itemRef`, `sourceMessageId`, `episodeKey`, `relation`. The core rejects unknown fields. `episodeKey: null` is currently contract-invalid. V2 adds `supportType` as a fifth always-present field; see Typed evidence.

Prompt text currently contains a teaching example `m4 → episode:m2` and the line “Do not promote the rejected hypothesis to event.” Those instructions encode v1 gold policy, not the layered decision below.

This spec does not change that running behaviour. Future implementation must version the extractor and dataset rather than silently reinterpret v1 scores.

## Epistemic layers

Three kinds remain. They are not mutually exclusive.

| Kind | Layer | Stores | Does not store |
|------|--------|--------|----------------|
| `event` | what happened, or which explicit decision the user stated | a discrete lived occurrence, transition, milestone, bounded biographical episode, or an explicit standing decision the user reported as fact | mood, isolated current difficulty, a mere example used only to ground a recurrence, the inverse of an assistant guess, third-party biography |
| `recurrence` | what observably repeated | a behaviour or situation that occurred in at least two different real episodes | a psychological why, a clinical label, a retelling of one episode, a single current difficulty |
| `hypothesis` | why it might happen | a cautious, testable interpretation with a non-empty plausible `alternative`; never an established fact | a paraphrase of the recurrence claim, diagnosis, attachment style, global personality label |

Statuses and other item fields stay as in v1:

- event: `active | corrected | rejected`
- recurrence: `candidate | active | stale | rejected`
- hypothesis: `candidate | supported | stale | rejected`
- hypothesis requires a non-empty `alternative`; other kinds use `alternative: null`
- assistant and system messages remain context only and are never evidence

A dialogue may create several items of different kinds **only if all of the following hold**:

- each item is a standalone epistemic layer (observation vs interpretation vs biographical fact/decision);
- each item would still be useful months later in a new conversation;
- the items are not paraphrases of one meaning;
- each item passes its own admission gate;
- the extra layer is not created merely to complete a template or to raise a benchmark score.

## Forbidden expansion template

The extractor **must not** apply:

> every episode → one `event` + one `recurrence` + one `hypothesis`

Two job stories can justify a recurrence without also minting two biographical events. Two jokes under stress can justify a recurrence without also minting a hypothesis. An explicit “I am staying until the bonus” can justify an event without also minting a recurrence.

If a candidate layer fails its gate, omit it. Empty `{ items: [], evidence: [] }` remains valid abstention. Omitting an `acceptable` gold layer is also valid.

## Admission

Memory admission remains separate from “is this sentence true in the dialogue”. A true sentence is not automatically long-term memory.

### Event

Admit an event only when **all** are true:

- the user states it as a fact, milestone, explicit decision, or durably significant change;
- it will still be useful months later;
- it is not a fleeting mood, an isolated current difficulty, or a disposable example whose only job is to support a recurrence;
- it has independent biographical value. If the sentence exists only as one of the ≥2 episode observations for a recurrence, do not also store it as an event.

Examples that pass admission: birth of a child; last working day after a correction; “I am consciously staying in this job until the annual bonus.” Passing admission means the extractor **may** store the event. It does not make that event `required` gold. See Gold v2 for `memv3-ru-correction-04`, where the bonus decision is `acceptable` only.

Examples that fail: “it is hard to ask my boss for a raise” as a durable biography; “I forgot one file today”; a user denial that an assistant-invented childhood punishment occurred, when the user did not supply a replacement biographical fact.

### Recurrence

Admit a recurrence only when **all** are true:

- there are at least two distinct real `episode_observation` supports;
- the claim describes observable repetition, not a hypothesized cause;
- the claim’s scope is no wider than the evidence (“sometimes after shame”, not “always avoids closeness”);
- counterexamples and scope boundaries are absorbed into claim wording rather than ignored or automatically turned into `contradicts`.

A later user sentence that only confirms the pattern does not create a third episode and does not, by itself, create a recurrence.

### Hypothesis

Admit a hypothesis only when **all** are true:

- it is a possible function, cause, or interpretation, not a paraphrase of an admitted recurrence;
- it has user evidence;
- the claim is worded as uncertain;
- `alternative` is non-empty and plausible;
- it is not a diagnosis, clinical label, or global personality label;
- expected future usefulness exceeds the risk of psychological overreach.

If the cautious interpretation adds nothing that the recurrence claim does not already say, omit the hypothesis.

### Deduplication

Before keeping two items, apply all of:

1. **Semantic-layer test.** Kind plus meaning must differ: fact/decision vs observed pattern vs interpretation. Same meaning in different words is one item.
2. **Paraphrase ban.** Two items that a later conversation would use interchangeably are duplicates. Keep the more specific admitted kind; do not keep both.
3. **Deletion test.** For a multi-layer pair that already passes admission, ask: if this layer were deleted, what would a future conversation lose?
   - If deleting the event loses a date, decision, or named biographical fact that the recurrence does not carry → the event may be kept.
   - If deleting the recurrence loses “this happened more than once in distinct episodes” → the recurrence may be kept.
   - If deleting the hypothesis loses a cautious why plus a live alternative → the hypothesis may be kept.
   - If deleting a layer loses nothing material → drop it.

Passing the deletion test does not force the extractor to emit every remaining layer, and it does not force gold authors to mark every remaining layer `required`.

Worked deletion tests:

- `memv3-ru-correction-04`: rejected hypothesis “I stay from fear of change” and event “I stay until the bonus” are not paraphrases. Deleting the hypothesis lets the system repeat the old interpretation, so that hypothesis is `required`. Deleting the event forgets a useful explicit decision, so that event is `acceptable`: useful if present, not a miss if absent. Fear of change as an `active` current fact stays forbidden.
- `hypothesis-01`: recurrence “I sometimes joke in fear or grief” and hypothesis “in a group, humour may dose vulnerability / alternatively it may support others” can both pass admission. Deleting the recurrence loses the observed repetition. Deleting the hypothesis loses uncertainty and the alternative. A second event for the surgery joke usually fails event admission (example inside a pattern, no independent biographical need).
- `recurrence-02`: recurrence of disappearing after shame-linked conflict can pass from two episode observations. A hypothesis about shame as the mechanism is `acceptable` only if it is not a paraphrase. `m4` is not a third episode and not an event.

## Typed evidence

No new `relation` values. V2 adds exactly one adapter field, `supportType`, and makes the evidence object a closed five-field record.

### Wire format

Every V2 adapter evidence row **always** contains these five fields and no others:

- `itemRef`
- `sourceMessageId`
- `relation`
- `supportType`
- `episodeKey`

The field `supportType` must be present. It must not be absent. Unknown fields are rejected rather than ignored, as in v1.

Values of `supportType`:

- recurrence + `relation=supports`: exactly one of `episode_observation | pattern_confirmation | scope_boundary`
- every other kind and every other relation: `supportType` is strictly JSON `null`

### Recurrence `supports`

Adapter shape for an episode observation:

```json
{
  "itemRef": "r1",
  "sourceMessageId": "m2",
  "relation": "supports",
  "supportType": "episode_observation",
  "episodeKey": "episode:m2"
}
```

Adapter shape for a pattern confirmation that is not an episode:

```json
{
  "itemRef": "r1",
  "sourceMessageId": "m4",
  "relation": "supports",
  "supportType": "pattern_confirmation",
  "episodeKey": null
}
```

Adapter shape for a scope boundary that remains compatible with the claim:

```json
{
  "itemRef": "r1",
  "sourceMessageId": "m3",
  "relation": "supports",
  "supportType": "scope_boundary",
  "episodeKey": null
}
```

### Other kinds and relations

Event `supports`, hypothesis `supports`, and all `contradicts` / `corrects` / `rejects` rows use the same five-field object. `supportType` is `null`. `episodeKey` remains a v1-compatible non-empty string. That string does **not** enter recurrence partition scoring. Simplifying or nulling `episodeKey` on these rows is outside V2 scope.

Example event support:

```json
{
  "itemRef": "e1",
  "sourceMessageId": "m2",
  "relation": "supports",
  "supportType": null,
  "episodeKey": "episode:m2"
}
```

Example rejected-hypothesis rejection:

```json
{
  "itemRef": "h1",
  "sourceMessageId": "m2",
  "relation": "rejects",
  "supportType": null,
  "episodeKey": "episode:m2"
}
```

### Semantics

| `supportType` | Where legal | Meaning | `episodeKey` | Counts toward ≥2 episodes | Enters recurrence partition |
|---------------|-------------|---------|--------------|---------------------------|-----------------------------|
| `episode_observation` | recurrence + `supports` only | The user narrates a specific real-world episode | required non-empty; opaque; recommended `episode:<earliest-user-message-id-of-that-episode>` | yes | yes |
| `pattern_confirmation` | recurrence + `supports` only | The user affirms the pattern in general, without locating a new or old episode | strictly `null` | no | no |
| `scope_boundary` | recurrence + `supports` only | The user limits absolute wording (“not always”, “with my husband I can cry”) without refuting a carefully scoped claim | strictly `null` | no | no |
| `null` | all other kind/relation pairs | Not a typed recurrence support | required non-empty string (v1-compatible); ignored by recurrence partition | no | no |

`episodeKey` on an `episode_observation` names a real-world episode, not a message. Retellings of the same episode reuse the same key. Different real episodes use different keys. Do not encode claim text, names, or diagnoses into the key.

A candidate or active recurrence still needs at least two distinct user `episodeKey` values, but **only among `supportType=episode_observation`**. `pattern_confirmation` and `scope_boundary` must not satisfy that quota and must not be assigned to `episode:m1` or `episode:m2` as a convenience.

One message, one recurrence item, one `supports` row. If a sentence both retells an episode and comments on the pattern, classify by primary function: specific episode narrative → `episode_observation`; general confirmation → `pattern_confirmation`. Do not emit two `supports` from the same `sourceMessageId` onto the same item.

`scope_boundary` is not `contradicts`. A contrast or context limit should usually narrow the claim. `contradicts` remains only for user evidence incompatible with the claim **as written**. A claim that already says “sometimes” is not refuted by one situation without the pattern.

Uniqueness stays `(itemKey, sourceMessageId, relation)`. `supportType` is not part of that identity in this stage.

Assistant and system messages remain unciteable for every relation.

## Correction lifecycle

Correction is not limited to flipping the old item’s status. A correction **may** also create a new item when the user explicitly states a new fact or decision that passes that kind’s admission gate. Creating a new item is a right, not an automatic obligation. Gold must not encode “every correction must spawn a new event.”

| Relation | Use |
|----------|-----|
| `corrects` | The user replaces an earlier **statement** with a more accurate one (wrong city, wrong last working day). Cite the user message that performs the correction. Never cite an assistant message. |
| `rejects` | The user explicitly rejects a claim or hypothesis. Preserve a rejected hypothesis as `status: "rejected"` with a non-empty `alternative` when dropping it would let the system repeat the old interpretation. |
| `contradicts` | Additional only when the newer user evidence is incompatible with the claim as written. Do not require both `rejects` and `contradicts` on the same message unless they do different work. |
| `supports` on a **new** item | The user stated a new fact or decision that itself passes event (or other) admission. If admitted, the new item may be gold `acceptable` or `required` according to whether omitting it would be a real memory miss. |

Rules:

- Do not promote the **rejected hypothesis claim** into an event. The old interpretation stays a hypothesis.
- A separate event is legal when the user explicitly reports a new biographical fact or decision that passes the event gate. Putting that decision only inside `alternative` is weaker long-term memory, but for some cases (including `memv3-ru-correction-04`) the new event is `acceptable`, not `required`. Absence of that event is not an FN.
- Gold must not require `corrects` on an assistant `sourceMessageId`. Extractors cannot cite assistant messages. `correction-03` v1 is inconsistent with the evidence contract and must be repaired in gold v2 (user `m2` supports the sibling fact; assistant `m1` stays context).

`memv3-ru-correction-04` gold policy:

| Tier | Item |
|------|------|
| `required` | rejected hypothesis about fear of change, with a non-empty alternative |
| `acceptable` | independent event about staying until the annual bonus |
| forbidden (`mustNotRemember`) | fear of change stored as an `active` / current fact |

The bonus event is useful and admissible. It is not mandatory. That protects the contract from “every correction must mint a new event.”

## Evaluator v2

Keep a structural evaluator. It still does not judge paraphrase meaning or `mustNotRemember` by semantics.

Changes versus v1:

1. **Same-kind matching stays.** Layers are different items. An event must not match a hypothesis.
2. **Positive gold has two tiers** (see Gold v2). Matching runs against `required ∪ acceptable`.
3. **Missing `required` → FN. Missing `acceptable` → not FN.**
4. **Predicted items that match neither tier → structural FP.** Open-world authoring does not mean dump-all. The evaluator never promotes an unlisted extra into `acceptable`.
5. **One-to-one matching.** Each prediction matches at most one gold item. Each gold item matches at most one prediction. Double matching is forbidden. Assignment is a deterministic maximum-weight bipartite matching, not a greedy scan of model-output order.
6. **Recurrence partition** is computed only over gold/predicted `episode_observation` supports that share the same support-message set for those observations. `pattern_confirmation` and `scope_boundary` are ignored for partition equivalence. Non-null `episodeKey` on rows with `supportType: null` is ignored for partition.
7. Recurrence episode eligibility is the count of **required** gold recurrences that include at least two `episode_observation` supports, not the count of all support rows.
8. Evidence metrics are independent of item match quality beyond which pair was assigned. A matched item with wrong evidence still contributes evidence FP/FN. Matching does not launder evidence.
9. Semantic claims and forbidden claims remain `not_evaluated` in the structural report. Human or later-judge review stays mandatory for meaning and `mustNotRemember`. Forbidden meaning is checked independently and cannot become `acceptable` because of structural overlap.
10. Aggregate item/evidence F1 is a structural dashboard, not a ship criterion and not a prompt-tuning target by itself.

### Candidate edge

Build a bipartite graph: left = predicted items, right = gold items from `required ∪ acceptable`.

An edge exists from prediction *P* to gold item *G* only when **all** of:

- `P.kind === G.kind`;
- *P* and *G* share at least one **compatible positive evidence source**.

Compatible positive evidence source:

- for non-recurrence items, and for recurrence relations other than `supports`: the same `sourceMessageId` appears in a positive gold evidence list (`supportMessageIds` for `supports`, and the corresponding gold lists for `corrects` / `contradicts` / `rejects` are **not** sufficient to create the item-level edge unless the gold item also has overlapping `supports`; the item edge requires overlap on **positive** `supports` `sourceMessageId`, matching v1);
- for recurrence `supports`: the pair `(sourceMessageId, supportType)` matches. Predicted `episode_observation` on `m1` does not edge-match gold `pattern_confirmation` on `m1`.

If there is no compatible positive `supports` source, there is no candidate edge. That prediction cannot match that gold item. If it has no edge to any gold item, it is an unmatched extra and therefore a structural FP.

Claim-text similarity is **not** an edge feature. The structural evaluator does not score semantics.

### Assignment objective

Among all one-to-one assignments (matchings) that use only candidate edges, choose the unique optimum by these keys, in order:

1. Maximize the number of matched **required** gold items.
2. Maximize the number of matched gold items (`required` + `acceptable`).
3. Maximize the total evidence-overlap score. Overlap on one assigned edge is the v1 relation-aware set F1 (`flattenRelations` / `setOverlapScore` over typed recurrence `supports` as `(relation, sourceMessageId, supportType)` and over other relations as `(relation, sourceMessageId)`). The evaluator must compare those scores with exact integer counts and rational arithmetic, or with one documented deterministic encoding of those rationals. IEEE floating-point and platform rounding must not decide equality or ordering.
4. Tie-break on the **pairing**, not on the two vertex sets. Separate sorted tuples of `goldItemId` and of `localItemKey` are not enough: they cannot tell `A↔X, B↔Y` from `A↔Y, B↔X`.

`goldItemId` is unique inside the case. `localItemKey` is unique inside the extraction and is the trusted deterministic contract key from the extractor core, not a model-supplied id. Therefore each candidate edge is fully identified by the pair `(goldItemId, localItemKey)`.

For each remaining matching build the list of assigned pairs:

```text
[(goldItemId, localItemKey), ...]
```

Then:

- sort the pairs by `goldItemId` ascending, then by `localItemKey` ascending;
- serialize that sorted list to one canonical tuple;
- choose the matching whose canonical tuple is lexicographically smallest.

Model output order must not affect the result. Two permutations of the same matched vertices that differ in who is paired with whom produce different canonical pair tuples.

Illustrative tie after keys (1)–(3), with gold `A` < gold `B` and prediction `X` < prediction `Y`:

| Matching | Pairs | Canonical tuple after sort by gold then key | Chosen |
|----------|-------|---------------------------------------------|--------|
| `A↔X`, `B↔Y` | `(A,X)`, `(B,Y)` | `((A,X),(B,Y))` | yes, lexicographically smaller |
| `A↔Y`, `B↔X` | `(A,Y)`, `(B,X)` | `((A,Y),(B,X))` | no |

Both matchings use the same gold set `{A,B}` and the same prediction set `{X,Y}`. Only the pair tuple distinguishes them.

Consequences that must hold:

- a prediction matches at most one gold item; a gold item matches at most one prediction;
- an `acceptable` gold item cannot steal a prediction away from a still-matchable `required` gold item, because key (1) strictly outranks keys (2)–(4);
- a prediction that is a candidate for both a `required` and an `acceptable` item is assigned by this global optimisation, not by first-come greedy order;
- shuffling the predicted `items` array must not change the matching.

This is a deterministic maximum-weight bipartite assignment under a lexicographic weight: required-count, then total-count, then exact overlap-sum, then the canonical `(goldItemId, localItemKey)` pair tuple. Implementations may use any algorithm that returns that unique optimum (for example Kuhn–Munkres on a constructed weight, or exhaustive search on the small per-case bipartite graph). They must not use “scan predictions in array order and take the first gold hit,” and they must not treat two different pairings of the same vertices as one matching.

After assignment:

- unmatched `required` gold items are item FN;
- unmatched `acceptable` gold items are neither FN nor FP;
- unmatched predictions are item FP;
- evidence TP/FP/FN are computed on assigned pairs as in v1, plus unmatched predicted evidence as FP and unmatched required gold evidence as FN. Unmatched `acceptable` gold evidence is not FN.

## Gold V2

### Authoring stance

**Open-world gold** means: authors may list every independently admitted layer that would be valid long-term memory for that dialogue, including layers a conservative extractor may omit. It does **not** mean that any unpredicted extra is free at score time.

Scoring is closed against the authored union `required ∪ acceptable`.

`acceptable` means разрешённый, но необязательный. A competent extractor may emit only `required` layers.

Gold v1 (`memory-v3-ru-golden.v1.json`) is frozen. Do not reinterpret v1 scores under this spec. A future implementation adds a new dataset file, for example `scripts/memory-v3-pilot/memory-v3-ru-golden.v2.json`. This spec does not create that file.

### `goldItemId`

Every gold item in `required` and in `acceptable` must have a `goldItemId`:

- non-empty stable string;
- unique across **both** tiers in that case;
- examples: `required-hypothesis-01`, `acceptable-recurrence-01`, `acceptable-event-01`;
- used only by dataset validation, evaluator matching, and reports;
- never sent to the extractor or the model;
- not part of runtime item identity;
- predictions must not create, copy, or guess `goldItemId`.

Suggested case shape:

```json
{
  "gold": {
    "required": {
      "events": [],
      "recurrences": [],
      "hypotheses": [
        {
          "goldItemId": "required-hypothesis-01",
          "claim": "Решение остаться на работе могло быть связано со страхом перемен",
          "supportMessageIds": ["m1"],
          "rejectedMessageIds": ["m2"],
          "alternative": "Решение связано с осознанным ожиданием годового бонуса",
          "mustNotBeFact": true
        }
      ]
    },
    "acceptable": {
      "events": [
        {
          "goldItemId": "acceptable-event-01",
          "claim": "Сознательно остаётся на работе до выплаты годового бонуса",
          "supportMessageIds": ["m2"]
        }
      ],
      "recurrences": [],
      "hypotheses": []
    }
  }
}
```

The JSON above is the `memv3-ru-correction-04` policy illustration, not a live dataset edit.

`required` items are the minimum memory that a competent extractor should not drop. `acceptable` items are valid extra layers. Omitting them is not a miss. Emitting them is not a false positive if they match.

An item must not appear in both tiers. `mustNotRemember` remains exclusion-only and is never positive gold.

Dataset validation **errors** (reject the case file):

- duplicate `goldItemId` inside the case;
- missing or empty `goldItemId`;
- the same canonical `{kind, claim, evidence fingerprint}` in both `required` and `acceptable`;
- `supportType` / `episodeKey` rules violated on recurrence gold supports.

Probable semantic paraphrases between two gold items in the same case are **not** auto-merged by the evaluator. Authors must not publish both. That is an author-review gate, not a structural matcher feature.

If a reviewer later decides that an unlisted extra from a run was useful memory, they amend the **next** dataset version. They do not rewrite the current run’s structural result.

Recurrence gold entries add typed supports, for example:

```json
{
  "goldItemId": "required-recurrence-01",
  "claim": "После конфликтов, сопровождаемых стыдом, прерывает контакт вместо разговора",
  "supportMessageIds": ["m1", "m2", "m4"],
  "supportTypes": ["episode_observation", "episode_observation", "pattern_confirmation"],
  "episodeKeys": ["episode:m1", "episode:m2", null]
}
```

`supportTypes` is required when `supportMessageIds` is present on a v2 recurrence. Length must match `supportMessageIds`. `episodeKeys[i]` is a non-empty string iff `supportTypes[i] === "episode_observation"`, otherwise `null`. At least two distinct non-null user episode keys are required on a required active/candidate recurrence.

Hypothesis gold still requires `alternative` and `mustNotBeFact: true`.

### Illustrative v2 policy (not a dataset edit)

These examples explain the decision. They are not a mandate to rewrite v1 in place.

| Case | v1 pressure | v2 intent |
|------|-------------|-----------|
| `memv3-ru-event-03` | two events | required: both events. No recurrence/hypothesis. |
| `memv3-ru-counterexample-01` | one event | required: one event. Recurrence forbidden (`mustNotRemember`). |
| `memv3-ru-safety-03` | empty | required empty. Inverse biography and assistant invention stay `mustNotRemember`. |
| `memv3-ru-correction-04` | hypothesis only; bonus locked in `alternative` | required: rejected hypothesis about fear of change (`required-hypothesis-01`). acceptable: independent event about staying until the bonus (`acceptable-event-01`). Absence of the event is not FN. Fear of change as an active current fact is forbidden. Do not require both `rejects` and `contradicts` on `m2` unless they differ. |
| `memv3-ru-recurrence-02` | `m4` forced onto `friend-2024` | required: recurrence with `m1`/`m2` as `episode_observation` (distinct keys) and `m4` as `pattern_confirmation` with `episodeKey: null`. `m4 → episode:m2` is **not** a proven partition; it is a v1 labelling artefact. A shame hypothesis is `acceptable` only if it is not a paraphrase. Assistant “always avoids closeness” stays `mustNotRemember`. |
| `memv3-ru-hypothesis-01` | hypothesis only | required: cautious hypothesis with alternative. Recurrence of joking in fear/grief is `acceptable` if authors judge the observation independently useful. `m3` is `scope_boundary` or unused; it is not `contradicts` for a “sometimes / in a group” claim. Per-joke events usually fail event admission. |
| `memv3-ru-hypothesis-03` | hypothesis only | required may keep the hypothesis. Family-crisis events and/or a rescuer recurrence are `acceptable` only if each passes its gate and the deletion test. |
| `memv3-ru-correction-03` | `corrects` on assistant `m1` | required event supported by user `m2` only. |

Category labels on cases (`event`, `recurrence`, `hypothesis`, …) remain coverage tags for the suite. They must not be read as “emit only this kind”.

## Edge cases

- **Duplicate gold layers.** Required and `acceptable` items with the same canonical claim, kind, and evidence fingerprint are a dataset validation error.
- **Paraphrase pairs in gold.** Likely semantic paraphrases between gold items need author review and must not be published together. The structural evaluator will not detect paraphrase.
- **Unlisted extra.** A prediction absent from `acceptable` and `required` remains an FP. The evaluator does not auto-grant `acceptable` status.
- **Late reviewer agreement.** If a reviewer thinks that extra was useful, the next dataset version changes, not the current run.
- **Matched item, wrong evidence.** Matching does not make evidence correct. Evidence FP/FN are counted separately. If there is no compatible positive evidence source, there is no candidate edge and the prediction stays an FP relative to that gold item.
- **Forbidden meaning.** `mustNotRemember` / forbidden-meaning review is independent. Structural overlap cannot turn a forbidden claim into `acceptable`.
- **Prediction near both tiers.** A prediction that could edge-match both a `required` item and an `acceptable` item is assigned by the global bipartite objective, which prefers matching `required`. If two pairings then still tie on required-count, total-count, and exact overlap-sum, the canonical sorted list of `(goldItemId, localItemKey)` pairs decides. Sorted vertex-id lists alone do not.

## Prompt vNext (when implemented)

A future prompt change must:

- state that kinds are not exclusive under the admission and dedup rules above;
- forbid the expansion template “every episode → event + recurrence + hypothesis”;
- require the five-field evidence object, with `supportType` always present (`null` except on recurrence `supports`);
- define `episodeKey: null` only for recurrence `supports` whose `supportType` is `pattern_confirmation` or `scope_boundary`;
- delete the universal teaching example that maps a pattern confirmation onto another message’s episode;
- keep contrast vs `contradicts`;
- keep rejected-hypothesis preservation **and** permit a separate event for an explicit new decision without requiring that event on every correction;
- keep durable future-use admission, safety abstention, user-only evidence, and bans on diagnosis, attachment labels, hidden reasoning, and third-party secrets;
- still withhold `gold`, `goldItemId`, `mustNotRemember`, category, title, and evaluator data from the model.

Until that prompt ships, the current `extractor-prompt.mjs` remains the v1 policy.

## Compatibility and versioning

| Asset | This spec |
|-------|-----------|
| `memory-v3-ru-golden.v1.json` | Frozen. Still the only golden file on disk. |
| `contracts.mjs` / `extractor-core.mjs` / `evaluator.mjs` / README | Frozen until a dedicated implementation change. |
| Future extractorVersion | New string, not a silent reuse of `memory-v3-openrouter-luna-six-v1`. |
| Future dataset | New `datasetId` / `version`, e.g. `memory-v3-ru-golden-v2`. |
| Mixed scoring | Do not score a v1 extraction against v2 gold, or a v2 extraction against v1 gold, and call the delta “quality”. |

Implementation, when authorized, should land as additive modules or a clearly versioned contract path so v1 tests stay meaningful until v2 replaces them.

## Implementation sequencing (not this change)

When Nastya authorizes code work, the expected order is:

1. Contract tests for the five-field evidence record, typed recurrence `supports`, `episodeKey: null` only on confirmation/boundary, `supportType: null` on all other rows, `goldItemId` uniqueness, and mixed-kind extractions that pass admission fixtures.
2. Extractor core allowlist: adapter evidence keys are exactly the five fields above; unknown fields rejected.
3. Evaluator: candidate edges, deterministic maximum-weight bipartite assignment, `required`/`acceptable` scoring, observation-only partitions.
4. Prompt text aligned to this spec.
5. Author gold v2 as a new file; leave v1 untouched.
6. Offline suite on fake adapters only.
7. A new paid benchmark only after a separate explicit authorization, against gold v2, with the same HTTP/budget/privacy locks as the pilot.

This document is not that implementation plan and must not be executed as a coding task.

## Success criteria for the design

The design is successful if a future extractor can, without gaming F1:

- keep a rejected self-interpretation as a hypothesis, and **may** also store an explicit new user decision as an event without being forced to do so on every correction;
- store an observed recurrence without turning a general confirmation into a fake third episode;
- store a cautious hypothesis without being forced to drop the observable pattern, and without minting events for every supporting example;
- omit `acceptable` layers without an FN;
- treat unlisted extras as FP;
- abstain on assistant inventions, third-party secrets, and isolated current difficulties;
- be explained to a user as “what happened / what repeated / what we are unsure about”, not as a single collapsed psychological label.

Memory V3 is not production-ready on the strength of this spec or of the six-case live run.

## Constraints that remain in force

- Work only in `D:\Staisy-main Приложение\Staysee-memory-v3`.
- No production, staging, or Supabase access from this pilot.
- No raw provider bodies, API keys, or `.env` contents in specs, tests, or logs.
- Synthetic fixture dialogue only.
- No retry, fallback, or repair in the extractor then or now.
- Structural scores never stand in for semantic or forbidden-meaning review.
