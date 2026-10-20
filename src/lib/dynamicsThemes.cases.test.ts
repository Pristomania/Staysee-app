// "Что повторяется" on the conversation dynamics screen now comes from the new memory
// (recurring patterns the person has lived through at least twice), not from the old
// conversation summary. This is the pure selection rule, tested for real.
import { selectRepeatingThemes } from "./dynamicsThemes.ts";

type Item = Parameters<typeof selectRepeatingThemes>[0][number];

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

const CHAT = "11111111-1111-4111-8111-111111111111";
const OTHER_CHAT = "22222222-2222-4222-8222-222222222222";

function item(overrides: Partial<Item> = {}): Item {
  return {
    memoryKey: `key-${Math.random()}`,
    kind: "recurrence",
    claim: "Тревожится перед публичными выступлениями",
    eventTimeStart: null,
    eventTimeEnd: null,
    sensitivity: "normal",
    topic: null,
    firstSeenAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-10T10:00:00Z",
    alternative: null,
    conversationId: CHAT,
    replacesMemoryKey: null,
    replacedByMemoryKey: null,
    ...overrides,
  };
}

// Only recurring patterns of THIS conversation count.
assertEqual(
  selectRepeatingThemes([item()], CHAT),
  ["Тревожится перед публичными выступлениями"],
  "a recurrence of this conversation is a repeating theme",
);
assertEqual(
  selectRepeatingThemes([item({ kind: "event" }), item({ kind: "hypothesis" })], CHAT),
  [],
  "facts and hypotheses are not repeating themes",
);
assertEqual(
  selectRepeatingThemes([item({ conversationId: OTHER_CHAT }), item({ conversationId: null })], CHAT),
  [],
  "another chat's items and account-wide items never appear in this chat's screen",
);
assertEqual(
  selectRepeatingThemes([item({ replacedByMemoryKey: "newer" })], CHAT),
  [],
  "a pattern that has been replaced by a newer one is gone",
);

// Newest first, no near-duplicates, no blanks, a sensible cap.
assertEqual(
  selectRepeatingThemes(
    [
      item({ claim: "Старая закономерность", updatedAt: "2026-10-01T00:00:00Z" }),
      item({ claim: "Свежая закономерность", updatedAt: "2026-10-15T00:00:00Z" }),
      item({ claim: "  ", updatedAt: "2026-10-16T00:00:00Z" }),
    ],
    CHAT,
  ),
  ["Свежая закономерность", "Старая закономерность"],
  "newest first, blanks dropped",
);
assertEqual(
  selectRepeatingThemes(
    [
      item({ claim: "Тревожится перед выступлениями", updatedAt: "2026-10-15T00:00:00Z" }),
      item({ claim: "тревожится перед выступлениями ", updatedAt: "2026-10-14T00:00:00Z" }),
    ],
    CHAT,
  ),
  ["Тревожится перед выступлениями"],
  "the same pattern written twice is shown once",
);
const many = Array.from({ length: 12 }, (_, i) =>
  item({ claim: `Закономерность номер ${i + 1}`, updatedAt: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00Z` }));
assertEqual(selectRepeatingThemes(many, CHAT).length, 8, "at most eight themes on the screen");
assertEqual(selectRepeatingThemes([], CHAT), [], "nothing in, nothing out");

console.log("PASS: dynamicsThemes.cases.test.ts");
