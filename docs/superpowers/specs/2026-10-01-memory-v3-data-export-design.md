# Memory V3 Data Export — Design

## Why

Настя audited the memory system for non-obvious gaps and found one grounded
in published research on long-term LLM memory systems: StaySee lets a user
delete their memory (all at once, or one item at a time) but gives them no
way to see or take a copy of everything the app remembers about them. For
an app handling psychologically sensitive content, that's a trust gap today
and plausibly a compliance gap later — the research she reviewed flags
"download your data" as a feature regulators increasingly expect, and one
every major consumer AI product (ChatGPT, Google, Facebook) already ships.

## Scope

**In scope:** a single export covering everything in Memory V3 — lifecycle
(account-wide) facts and dialogue (per-conversation) facts, across **all**
of the user's conversations at once, **including hypotheses** (shown in the
export even though the regular Память screen hides them, since the export's
job is full transparency, not day-to-day browsing). The user picks PDF or
JSON at the moment they click, gets the file immediately in the browser.

**Explicitly out of scope** (keeps this change small and matches what
Настя actually decided, not what ChatGPT happens to do):
- Raw conversation transcripts (the actual messages). StaySee's data
  volume doesn't need ChatGPT's archive-by-email pattern, and Настя chose
  memory-only.
- Email delivery, temporary storage, expiring links, or any cleanup job.
  The export is generated and downloaded synchronously in one request;
  nothing is written to disk or a bucket server-side.
- Remembering the user's PDF/JSON choice. Asked every time.
- Legacy (pre-Memory-V3) memory data. That system is being phased out and
  is enabled for exactly one account (see `memoryScreenMode.ts`); not worth
  carrying into a new feature.

## Architecture

### Data flow

```
[Память screen] --click "Скачать мои данные"--> [choice: PDF | JSON]
                                                        |
                                                        v
                                    memory-v3-viewer, action: "export"
                                                        |
                        +-------------------------------+-------------------------------+
                        |                                                               |
      load_memory_v3_lifecycle_viewer_items(p_user_id)          load_memory_v3_dialogue_viewer_items_all(p_user_id)
      (existing RPC, unchanged)                                  (NEW RPC — same shape as the existing
                                                                   per-conversation one, minus the
                                                                   conversation_id filter)
                        |                                                               |
                        +-------------------------------+-------------------------------+
                                                        |
                                projectMemoryV3ExportItems (NEW — like projectMemoryV3ViewerItems
                                but keeps hypothesis items instead of dropping them)
                                                        |
                                                        v
                                    { accountWide: [...], dialogue: [...] }
                                                        |
                                    JSON choice --------+-------- PDF choice
                                           |                            |
                                   Blob + <a download>         same JSON fed into a client-side
                                   triggers browser save        PDF layout (new dependency, e.g. jsPDF)
```

### New backend piece: `load_memory_v3_dialogue_viewer_items_all`

A new migration adds this RPC, mirroring `load_memory_v3_dialogue_viewer_items`
exactly (same `SECURITY DEFINER`, same `REVOKE ALL ... GRANT ... service_role`
pattern, same returned field shape: `memoryKey, kind, claim, sensitivity,
eventTimeStart, eventTimeEnd, topic, firstSeenAt, updatedAt`) but scoped by
`user_id` only, across every row in `memory_v3_dialogue_items` for that user
— no `conversation_id` parameter, no per-conversation filter. It does **not**
touch, replace, or deprecate the existing per-conversation RPC, which the
regular Память screen keeps using exactly as today.

### New projection: `projectMemoryV3ExportItems`

Lives beside `projectMemoryV3ViewerItems` in `viewerProjection.ts`. Same
claim-cleanup behavior (strips a leading "пользователь"/"клиент" word), but
keeps every `kind` (`event`, `recurrence`, `hypothesis`) instead of filtering
to `event`/`recurrence` only, and keeps the `alternative` field (currently
dropped by the regular viewer projection) since a hypothesis without its
alternative is not very transparent. The regular `projectMemoryV3ViewerItems`
is untouched — the day-to-day Память screen's behavior does not change.

### `memory-v3-viewer` edge function: new `"export"` action

Added alongside the existing `"read"`, `"delete"`, `"delete_all"` actions,
same auth check (`resolveVerifiedChatUser`, same JWT-matches-requested-user
guard already in place for every other action). Calls both RPCs, projects
both result sets through `projectMemoryV3ExportItems`, returns
`{ accountWide: [...], dialogue: [...] }`. No conversationId is accepted or
needed, since this always means "everything."

### Frontend: `MemoryScreen.tsx` / new export control

One button, placed above the per-conversation selector in the Память
section, labelled something like "Скачать мои данные". Clicking it reveals
an inline PDF/JSON choice (two small buttons appearing in place — no modal,
no separate screen). Picking one:
1. Calls the new `exportMemoryV3Data()` helper in `memoryV3Viewer.ts` (same
   `callMemoryV3Viewer` pattern already used for `read`/`delete`/`delete_all`).
2. **JSON**: serializes the response, wraps it in a `Blob`, and triggers a
   download via a temporary `<a download>` element — a standard, dependency-free
   browser pattern already usable with what's in this project.
3. **PDF**: feeds the same response into a new, small formatting function
   that lays out each section (Сквозная память / Память бесед) with their
   claims, topics, sensitivity, and ages (reusing the existing
   `formatMemoryRecordedOrUpdated` logic from `MemoryV3ItemList.tsx`), then
   calls a client-side PDF library (`jspdf`, MIT-licensed, no server
   dependency, a new `package.json` dependency) to produce and download the
   file. No PDF generation happens on the server.

Sensitive items are included in the export under their real claim text —
the "reveal" gate in the regular viewer is a screen-glance protection
(so someone looking over your shoulder doesn't see it by accident), not a
data-access control; the export is explicitly produced for the account's
own owner, so there is nothing to hide the export's contents from them.

## Error handling

- If either RPC call fails, the edge function returns the existing `{ error:
  "internal" }` shape the frontend already understands, and the export
  button surfaces its existing-pattern "Не удалось сохранить. Нажми ещё
  раз."-style error state rather than a half-written file.
- If `jspdf` throws while formatting (malformed data, over-long claim text,
  etc.), the user sees the same error state; nothing partial is written to
  disk since this is all in-memory until the final download trigger.
- No empty-state crash: an account with zero memory items still gets a
  valid (empty-arrays) file rather than an error.

## Testing

- New migration gets its own `*.cases.test.ts` (SQL-pattern-matching against
  the migration file text), following the exact convention already used for
  `viewerUpdatedAtMigration.cases.test.ts` / `viewerFirstSeenAtMigration.cases.test.ts`.
- `projectMemoryV3ExportItems` gets unit tests in `viewerProjection.cases.test.ts`
  (or a sibling file) covering: hypotheses are kept (not dropped), `alternative`
  is kept, claim-cleanup still applies, field set is exact.
- Frontend: `npm run typecheck` and `npx eslint` on the changed files (the
  project's established bar for this kind of UI change, per today's earlier
  PRs). No new automated test for the PDF-rendering path itself (visually
  inspecting the generated PDF is the realistic check here) — Настя (or
  whoever merges) does one real click-through in the browser before calling
  it done, same as the standing rule for UI changes in this project.

## Review Focus

- **Account with memory in multiple conversations**: the new "all
  conversations" RPC must return dialogue items from every conversation,
  not just the most recently active one — the most likely place a
  conversation-scoped mental model leaks in by accident.
- **Account with zero memory in one or both scopes**: export must produce a
  valid empty-but-well-formed file, not an error or a crash in the PDF
  layout code.
- **A hypothesis item**: must appear in the export with its `alternative`
  text, since that's the entire point of including hypotheses at all here.
- **A sensitive item**: must appear in the export under its real claim text,
  not behind a "reveal" placeholder — this is a deliberate scope decision
  (see Frontend section above), not an oversight, but it's the one place a
  reviewer might reflexively think the reveal-gate was supposed to carry
  over and flag it as a bug.
- **Claim text with characters that could break PDF layout or JSON escaping**
  (quotes, very long single claims, emoji) must not crash the export or
  produce a malformed file.
