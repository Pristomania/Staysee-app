// conversationDynamicsView.ts imports the real Supabase client at module
// scope, which reads Vite's import.meta.env (only populated inside a Vite
// build/dev run) -- importing it directly here throws. Reading the raw
// source and asserting against it with regexes is the same convention this
// project already uses on the Supabase/Deno side for files with
// unloadable deps (context.cases.test.ts, userLifeMemory.cases.test.ts).
//
// This project has no @types/node, so `node:fs` has no type declarations
// under tsconfig.app.json even though it resolves and runs fine via tsx
// (how this file is actually executed). A dynamic import keeps the
// specifier untyped instead of reaching for a blanket @ts-nocheck, which
// this project's eslint config forbids.
const nodeFs = (await import(/* @vite-ignore */ "node:fs/promises" as string)) as {
  readFile: (path: URL, encoding: string) => Promise<string>;
};

function assertMatch(value: string, pattern: RegExp, message: string): void {
  if (!pattern.test(value)) throw new Error(`${message}: expected to match ${pattern}`);
}

function assertDoesNotMatch(value: string, pattern: RegExp, message: string): void {
  if (pattern.test(value)) throw new Error(`${message}: expected not to match ${pattern}`);
}

const source = await nodeFs.readFile(new URL("./conversationDynamicsView.ts", import.meta.url), "utf8");

assertDoesNotMatch(source, /fetchCrossMemoryForUser/, "fetchCrossMemoryForUser should be fully removed");
assertMatch(source, /export async function fetchLinkedMemoryPairs/, "fetchLinkedMemoryPairs should be exported");
assertMatch(
  source,
  /import\s*\{[^}]*exportMemoryV3Data[^}]*\}\s*from\s*['"]\.\/memoryV3Viewer['"]/,
  "should import exportMemoryV3Data from ./memoryV3Viewer",
);
assertDoesNotMatch(source, /from\('user_memory'\)/, "should never query user_memory directly anymore");

assertDoesNotMatch(source, /function compareWeeklies/, "compareWeeklies text-diff helper should be removed");
assertDoesNotMatch(source, /function splitWeeklyPhrases/, "splitWeeklyPhrases helper should be removed");
assertMatch(source, /data\.linkedPairs/, "buildChangingView should read data.linkedPairs");

assertDoesNotMatch(source, /crossMemory/, "crossMemory field/identifier should be fully removed");
assertMatch(source, /linkedPairs: LinkedMemoryPair\[\]/, "ConversationDynamicsData should declare linkedPairs");
assertDoesNotMatch(
  source,
  /import type \{ UserMemory \} from '\.\.\/types';/,
  "the now-unused UserMemory import should be dropped",
);

// Dialogue memory keys are sha256(namespace, userId, ordinal) with no
// conversationId baked in -- the per-conversation ordinal counter resets for
// every new conversation, so two unrelated conversations' dialogue items can
// land on the identical memory_key. fetchLinkedMemoryPairs must scope its
// dialogue-side lookup to one conversation (account-wide/lifecycle pairs
// stay global, by design) so a pair in conversation A can never resolve its
// "old" end against an unrelated item in conversation B.
assertMatch(
  source,
  /export async function fetchLinkedMemoryPairs\(\s*conversationId: string,?\s*\)/,
  "fetchLinkedMemoryPairs should take a conversationId parameter",
);
assertMatch(
  source,
  /result\.dialogue\.filter\(\s*\(item\)\s*=>\s*item\.conversationId === conversationId\s*\)/,
  "should filter dialogue items to the current conversation before building the key map",
);

// repeatedItems was dead code: buildChangingView always returned [] for it
// (Task 6 rewrote the "repeated" concept away entirely, replacing it with
// linkedPairs), and TrendGroup/the screen's own render path already
// no-op on an empty array -- but the field, its type, and its two render
// sites lingered. Removed entirely rather than left as a permanent no-op.
assertDoesNotMatch(source, /repeatedItems/, "repeatedItems should be fully removed -- it was always []");

console.log("PASS: conversationDynamicsView.cases.test.ts (structural checks)");

// The checks above only confirm source TEXT, not BEHAVIOR -- they would
// never catch a real bug in buildChangingView's own date-window filtering
// logic (which pairs count as "since the previous weekly snapshot"). That
// logic is pure (no I/O), so it's worth testing for real, not just by
// string presence.
//
// The module can't be imported directly: it reads Vite's import.meta.env
// at module scope via ./supabase (and transitively via ./progressDiary
// and ./memoryV3Viewer), which throws under plain tsx. A node:module
// resolve() hook was tried first to redirect just those specifiers to
// stubs, but tsx does not route its own ESM resolution through hooks
// registered at runtime from inside the running script (confirmed: the
// hook's resolve() was never invoked for a real sibling import, even
// though the exact same hook correctly intercepted a specifier under
// plain Node). So instead: take the real source text, swap only the
// three problematic import lines for inert stubs (none of the three pure
// functions under test reference supabase/filterTensionNotes/
// exportMemoryV3Data/parseConversationMemory -- confirmed by reading the
// full file), write that to a throwaway sibling file (so the untouched
// ./memoryDisplay import -- which these functions DO use, and which has
// no problematic imports of its own -- still resolves normally), import
// it, then delete it. Every line of logic under test is the real,
// unmodified source; only the unrelated import statements are swapped.
const behavioralSource = await nodeFs.readFile(new URL("./conversationDynamicsView.ts", import.meta.url), "utf8");
const stubbedSource = behavioralSource
  .replace(
    "import { supabase } from './supabase';",
    "const supabase = undefined;",
  )
  .replace(
    "import { filterTensionNotes, type ProgressEntry } from './progressDiary';",
    "const filterTensionNotes = undefined; type ProgressEntry = any;",
  )
  .replace(
    "import { parseConversationMemory, type StructuredMemory } from './memoryUi';",
    "const parseConversationMemory = undefined; type StructuredMemory = any;",
  )
  .replace(
    "import { exportMemoryV3Data } from './memoryV3Viewer';",
    "const exportMemoryV3Data = undefined;",
  );
if (stubbedSource === behavioralSource) {
  throw new Error("none of the expected problematic import lines were found -- source may have changed shape");
}

const nodeFsSync = (await import(/* @vite-ignore */ "node:fs" as string)) as {
  writeFileSync: (path: URL, data: string) => void;
  unlinkSync: (path: URL) => void;
};
const tempModuleUrl = new URL("./__tmp_conversationDynamicsView_behavioral.ts", import.meta.url);

type DynamicsData = import("./conversationDynamicsView.ts").ConversationDynamicsData;
let buildChangingView: (data: DynamicsData) => {
  newItems: string[];
  fadedItems: string[];
  activityText: string | null;
  empty: boolean;
};
let buildRepeatingView: (data: DynamicsData) => Array<{ text: string; sublabel: string; displayText: string }>;
let buildAliveView: (data: DynamicsData) => Array<{ text: string; source: 'open_loops' | 'tension' | 'weekly' }>;
try {
  nodeFsSync.writeFileSync(tempModuleUrl, stubbedSource);
  const imported = (await import(`${tempModuleUrl.href}?t=${Date.now()}`)) as {
    buildChangingView: typeof buildChangingView;
    buildRepeatingView: typeof buildRepeatingView;
    buildAliveView: typeof buildAliveView;
  };
  buildChangingView = imported.buildChangingView;
  buildRepeatingView = imported.buildRepeatingView;
  buildAliveView = imported.buildAliveView;
} finally {
  nodeFsSync.unlinkSync(tempModuleUrl);
}

function baseData(overrides: Partial<Parameters<typeof buildChangingView>[0]> = {}) {
  return {
    memory: { themes: [], emotional_state: [], open_loops: [] } as never,
    weeklies: [],
    tensions: [],
    linkedPairs: [],
    messageActivity: { recentCount: 0, previousCount: 0 },
    ...overrides,
  };
}

console.log("\n=== buildChangingView date-window filtering (behavioral) ===\n");

// No previous weekly snapshot at all -- must never show pairs, even if they
// exist, since there's nothing to compare "since" against.
{
  const result = buildChangingView(baseData({
    weeklies: [{ created_at: "2026-10-10T00:00:00Z" } as never],
    linkedPairs: [{ newClaim: "new", oldClaim: "old", newUpdatedAt: "2026-10-09T00:00:00Z" }],
  }));
  assertMatch(JSON.stringify(result.newItems), /^\[\]$/, "with only one weekly ever, no pair should show");
}

// Pair strictly between previous and latest -- must show.
{
  const result = buildChangingView(baseData({
    weeklies: [
      { created_at: "2026-10-10T00:00:00Z" } as never,
      { created_at: "2026-10-03T00:00:00Z" } as never,
    ],
    linkedPairs: [{ newClaim: "сменила работу", oldClaim: "боялась", newUpdatedAt: "2026-10-05T00:00:00Z" }],
  }));
  assertMatch(JSON.stringify(result.newItems), /сменила работу/, "a pair strictly between the two snapshots should show");
}

// Pair before the previous snapshot -- already accounted for in an earlier
// week, must NOT show again.
{
  const result = buildChangingView(baseData({
    weeklies: [
      { created_at: "2026-10-10T00:00:00Z" } as never,
      { created_at: "2026-10-03T00:00:00Z" } as never,
    ],
    linkedPairs: [{ newClaim: "old news", oldClaim: "older", newUpdatedAt: "2026-10-01T00:00:00Z" }],
  }));
  assertMatch(JSON.stringify(result.newItems), /^\[\]$/, "a pair before the previous snapshot should not show");
}

// Boundary: exactly at previousWeeklyAt -- exclusive lower bound, must NOT show.
{
  const result = buildChangingView(baseData({
    weeklies: [
      { created_at: "2026-10-10T00:00:00Z" } as never,
      { created_at: "2026-10-03T00:00:00Z" } as never,
    ],
    linkedPairs: [{ newClaim: "boundary-low", oldClaim: "x", newUpdatedAt: "2026-10-03T00:00:00Z" }],
  }));
  assertMatch(JSON.stringify(result.newItems), /^\[\]$/, "a pair exactly at the previous snapshot's time should not show (exclusive lower bound)");
}

// Boundary: exactly at latestWeeklyAt -- inclusive upper bound, must show.
{
  const result = buildChangingView(baseData({
    weeklies: [
      { created_at: "2026-10-10T00:00:00Z" } as never,
      { created_at: "2026-10-03T00:00:00Z" } as never,
    ],
    linkedPairs: [{ newClaim: "boundary-high", oldClaim: "x", newUpdatedAt: "2026-10-10T00:00:00Z" }],
  }));
  assertMatch(JSON.stringify(result.newItems), /boundary-high/, "a pair exactly at the latest snapshot's time should show (inclusive upper bound)");
}

// More than 4 qualifying pairs -- must cap at 4, not silently show all or crash.
{
  const pairs = Array.from({ length: 6 }, (_, i) => ({
    newClaim: `new-${i}`, oldClaim: `old-${i}`, newUpdatedAt: "2026-10-05T00:00:00Z",
  }));
  const result = buildChangingView(baseData({
    weeklies: [
      { created_at: "2026-10-10T00:00:00Z" } as never,
      { created_at: "2026-10-03T00:00:00Z" } as never,
    ],
    linkedPairs: pairs,
  }));
  assertMatch(String(result.newItems.length), /^4$/, `should cap at 4 items, got ${result.newItems.length}`);
}

console.log("All buildChangingView date-window behavioral cases passed.");

console.log("\n=== buildRepeatingView theme classification (behavioral) ===\n");

// A theme that shows up in at least 2 weeklies' text should be flagged as
// "returnsHere", not just "inFocus".
{
  const result = buildRepeatingView(baseData({
    memory: { themes: ['страх'], emotional_state: [], open_loops: [] } as never,
    weeklies: [
      { content: 'на этой неделе снова был страх перед разговором' } as never,
      { content: 'в начале недели тоже был страх' } as never,
    ],
  }));
  const match = result.find((r) => r.text === 'страх');
  if (!match) throw new Error('expected theme "страх" to appear in buildRepeatingView output');
  assertMatch(match.sublabel, /^returnsHere$/, 'a theme present in 2+ weeklies should be sublabel returnsHere');
}

// A theme with no weekly overlap (or fewer than 2 weeklies) should be
// "inFocus" instead.
{
  const result = buildRepeatingView(baseData({
    memory: { themes: ['истощение'], emotional_state: [], open_loops: [] } as never,
    weeklies: [{ content: 'ничего похожего тут нет' } as never],
  }));
  const match = result.find((r) => r.text === 'истощение');
  if (!match) throw new Error('expected theme "истощение" to appear in buildRepeatingView output');
  assertMatch(match.sublabel, /^inFocus$/, 'a theme without weekly overlap should be sublabel inFocus');
}

// No themes at all -- must return an empty list, not throw.
{
  const result = buildRepeatingView(baseData({
    memory: { themes: [], emotional_state: [], open_loops: [] } as never,
  }));
  assertMatch(String(result.length), /^0$/, 'no themes should produce an empty repeating view');
}

console.log("All buildRepeatingView behavioral cases passed.");

console.log("\n=== buildAliveView source tagging (behavioral) ===\n");

// open_loops entries should come through tagged source: 'open_loops'.
{
  const result = buildAliveView(baseData({
    memory: { themes: [], emotional_state: [], open_loops: ['найти нового терапевта'] } as never,
  }));
  const match = result.find((r) => r.text === 'найти нового терапевта');
  if (!match) throw new Error('expected open_loop item to appear in buildAliveView output');
  assertMatch(match.source, /^open_loops$/, 'an open_loops entry should be tagged source open_loops');
}

// tensions entries should come through tagged source: 'tension', and a
// tension that duplicates an already-added open_loop must be skipped
// rather than shown twice.
{
  const result = buildAliveView(baseData({
    memory: { themes: [], emotional_state: [], open_loops: ['конфликт с мамой'] } as never,
    tensions: [
      { content: 'конфликт с мамой' } as never,
      { content: 'тревога перед экзаменом' } as never,
    ],
  }));
  const distinctTension = result.find((r) => r.text === 'тревога перед экзаменом');
  if (!distinctTension) throw new Error('expected distinct tension item to appear in buildAliveView output');
  assertMatch(distinctTension.source, /^tension$/, 'a tensions entry should be tagged source tension');
  const duplicateCount = result.filter((r) => r.text === 'конфликт с мамой').length;
  assertMatch(String(duplicateCount), /^1$/, 'a tension duplicating an open_loop should not be shown a second time');
}

// A line in the latest weekly matching the "unfinished" phrasing should
// surface tagged source: 'weekly'; unrelated weekly text should not.
{
  const result = buildAliveView(baseData({
    weeklies: [{ content: 'незавершённой остаётся тема переезда' } as never],
  }));
  const match = result.find((r) => r.source === 'weekly');
  if (!match) throw new Error('expected an "unfinished" line from the latest weekly to surface with source weekly');
}
{
  const result = buildAliveView(baseData({
    weeklies: [{ content: 'на этой неделе всё было спокойно' } as never],
  }));
  const weeklyItems = result.filter((r) => r.source === 'weekly');
  assertMatch(String(weeklyItems.length), /^0$/, 'ordinary weekly text with no "unfinished" phrasing should add nothing');
}

console.log("All buildAliveView behavioral cases passed.");

console.log("\nPASS: conversationDynamicsView.cases.test.ts");
