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

console.log("PASS: conversationDynamicsView.cases.test.ts");
