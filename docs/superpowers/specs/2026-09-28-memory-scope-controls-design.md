# StaySee Memory Scope Controls Design

**Date:** 2026-09-28

## Goal

Separate profile-level memory management from conversation-level memory controls so the interface and runtime behavior match the product model:

- the profile is the only place that lists all conversations and applies a cross-memory setting to all conversations;
- a conversation page shows only that conversation;
- each conversation can independently enable or disable cross-memory;
- dialogue memory always remains independent from cross-memory.

## Product rules

### Profile memory view

The Memory page opened from Profile is the memory management center.

It must:

1. Show the conversation picker.
2. Let the user inspect the dialogue memory of the selected conversation.
3. Show and manage account-wide cross-memory facts.
4. Provide a bulk switch for cross-memory.
5. Explain that the bulk switch affects every existing conversation and becomes the default for new conversations.

Turning the profile switch off sets cross-memory off for every existing conversation and makes it off by default for future conversations. Turning it on sets it on for every existing conversation and makes it on by default for future conversations.

### Conversation memory view

The Memory page opened from a chat is scoped to the current conversation.

It must:

1. Never show the conversation picker or another conversation's memory.
2. Show the current conversation title and its dialogue memory.
3. Provide a switch labelled in user-facing copy as using cross-memory in this conversation.
4. Let the user enable cross-memory for this conversation even when the profile default is off.
5. Let the user disable cross-memory for this conversation even when the profile default is on.
6. Not expose the account-wide fact editor. Account-wide facts are managed from Profile.

When the profile default is off and the user enables one conversation, all other existing conversations remain off and future conversations remain off. The conversation view displays a short explanation of this exception.

### Dialogue memory independence

The conversation switch controls only cross-memory. It must not disable, clear, hide, or stop updating the dialogue memory that belongs to that conversation.

## Chosen model

Use two explicit boolean settings:

- `profiles.cross_memory_enabled`: the profile default and the value used by the bulk action;
- `conversations.cross_memory_enabled`: the effective cross-memory setting for that conversation.

The conversation value is authoritative during a chat turn. The profile value is not a hard global kill switch: it seeds new conversations and is copied to all existing conversations by the profile bulk action. This is required so a user can enable one conversation while the profile default remains off.

### Alternatives rejected

1. **Profile value as a hard master gate.** Rejected because a conversation could not opt in while the profile value is off.
2. **Nullable per-conversation override.** Rejected because a bulk profile action would have ambiguous behavior for old overrides and would be harder to explain. The approved product behavior is a concrete bulk reset followed by optional per-conversation exceptions.
3. **UI-only setting.** Rejected because cross-memory reads and writes happen in server functions and must be enforced there.

## Database design

Add `public.conversations.cross_memory_enabled boolean NOT NULL`.

Migration behavior:

1. Add the column safely.
2. Backfill every existing conversation from its owner's `profiles.cross_memory_enabled`, treating a missing legacy profile value as `true`.
3. Add an insert trigger that copies the current profile value into every newly created conversation. This keeps all conversation creation paths consistent.
4. Add an authenticated RPC for the profile bulk action. In one transaction it updates the profile default and all conversations owned by `auth.uid()`.
5. Add an authenticated RPC for changing one conversation. It updates only a conversation owned by `auth.uid()` and does not change the profile default or other conversations.
6. Revoke public/anonymous execution and grant only the intended authenticated role.

The migration must not modify memory contents.

## Runtime behavior

Create one server-side preference reader whose input is `userId` and `conversationId`. It verifies ownership and returns the conversation's effective boolean. During safe rollout, a missing column/read failure may fall back to the profile value and emit only a non-sensitive diagnostic.

Use the conversation setting for every live cross-memory path:

- legacy `user_memory` injection into the prompt;
- Memory V3 lifecycle read injection;
- legacy cross-memory refresh from the current conversation;
- Memory V3 lifecycle extraction/write from the current conversation.

Do not use it for:

- Memory V3 dialogue reads;
- Memory V3 dialogue writes;
- conversation summaries;
- notes, dynamics, or corrections that are scoped to the conversation.

This means disabling cross-memory for a conversation prevents that conversation both from receiving account-wide facts and from contributing new facts to account-wide memory. Its own dialogue memory continues normally.

## Frontend structure

### Shared controls

Split the current `CrossMemoryToggle` responsibilities into two explicit controls:

- a profile bulk/default control;
- a conversation-specific control.

Their copy must make the scope obvious. Neither control may silently behave like the other.

### Memory screen modes

`memoryReturnScreen` is the existing source of truth for how Memory was opened:

- `profile`: load the conversation list, permit selection, show account-wide memory and the profile bulk control;
- `chat`: lock the selected conversation to `currentConversation.id`, do not query or render the conversation list, show dialogue memory and the conversation-specific control only.

If chat-origin navigation lacks a valid current conversation, fail closed by returning to chat/profile navigation rather than silently selecting the user's newest conversation.

### New conversation creation

The database trigger owns inheritance of the profile default. The frontend includes the returned `cross_memory_enabled` field in the `Conversation` type so the current value can be rendered immediately and refreshed after a toggle.

## User-facing copy

Profile control:

- Title: `Сквозная память для всех бесед`
- On: `Включена во всех беседах и будет включена в новых.`
- Off: `Выключена во всех беседах и будет выключена в новых.`
- Action hint: `Настройку можно изменить отдельно внутри любой беседы.`

Conversation control:

- Title: `Использовать сквозную память в этой беседе`
- On: `StaySee может использовать здесь факты из других бесед и сохранять новые общие факты.`
- Off: `Здесь используется только память этой беседы.`
- Exception hint when the profile default is off but this conversation is on: `Для новых и остальных бесед сквозная память остаётся выключенной.`

Copy may be shortened to fit the existing visual system, but its meaning must not change.

## Error handling

- A failed toggle keeps the last confirmed state and shows a local retry message.
- The UI must not optimistically claim that all conversations changed before the bulk RPC succeeds.
- A server preference lookup failure falls back to the legacy profile value during deployment compatibility, never to an attacker-provided value.
- No errors or logs may contain memory text, message text, user IDs, conversation IDs, tokens, or secrets.

## Testing

### Database

- Existing conversations inherit the current profile value.
- New conversations inherit the profile default.
- The profile RPC updates the profile and all owned conversations only.
- The conversation RPC updates one owned conversation only.
- Cross-user mutation is rejected.

### Server

- Cross-memory is read and written when the conversation value is on.
- Cross-memory is neither read nor written when it is off.
- Dialogue memory still reads and writes when cross-memory is off.
- A conversation enabled while the profile default is off can read and write cross-memory.
- Legacy and Memory V3 paths use the same effective setting.

### Frontend

- Profile origin renders the picker, account-wide editor, and bulk control.
- Chat origin renders no picker and no account-wide editor.
- Chat origin cannot switch to another conversation.
- The two toggles call only their corresponding scoped operation.
- Failure copy and the profile-off/conversation-on hint are rendered correctly.

### Regression

Run the complete Memory V3 test set, frontend typecheck, lint, production build, and migration contract tests. No paid provider run is required for this feature.

## Deployment order

1. Apply the database migration.
2. Deploy `staysee-chat` with conversation-scoped gating.
3. Deploy the frontend.
4. Verify one profile bulk toggle and one per-conversation exception with non-paid smoke checks.

The order prevents the frontend or function from referencing a column/RPC before the database supports it.

## Out of scope

- A toggle for dialogue memory.
- Deleting or rebuilding any memory content.
- Changing Memory V3 extraction rules.
- Paid backfills or provider benchmarks.
- Changing the dialogue list outside the Profile memory view.
