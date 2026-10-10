/**
 * Weekly reflection privacy — insight/tension must not enter generation input.
 * Run: npx tsx supabase/functions/_shared/weeklyReflection.cases.test.ts
 */

import { register } from "node:module";

// weeklyReflection.ts has a type-only `npm:` specifier for SupabaseClient --
// same remap as cost.cases.test.ts, so local tsx can load
// buildWeeklyReflectionPrompt without changing production code.
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier === "string" && specifier.startsWith("npm:")) {
    const rest = specifier.slice(4);
    const bare = rest.startsWith("@")
      ? "@" + rest.slice(1).split("@")[0]
      : rest.split("@")[0];
    return nextResolve(bare, context);
  }
  return nextResolve(specifier, context);
}
`)}`,
);

import {
  isWeeklyReflectionVisibleEntryType,
  WEEKLY_REFLECTION_USER_MARK_ENTRY_TYPE,
} from "./weeklyReflectionPrivacy.ts";

// Transitive Edge modules read Deno.env at import time; stub only for local tsx.
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://sentinel.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "SERVICE_ROLE_SENTINEL_KEY",
  SUPABASE_ANON_KEY: "ANON_SENTINEL_KEY",
};
const g = globalThis as typeof globalThis & {
  Deno?: { env: { get: (key: string) => string | undefined } };
};
if (!g.Deno) {
  g.Deno = {
    env: {
      get(key: string) {
        return ENV[key];
      },
    },
  };
}

// Dynamic, not static -- static imports are hoisted above the register()
// call above, which would defeat the npm: remap for this one specifically.
const { buildWeeklyReflectionPrompt, fetchLinkedPairsForConversation } = await import("./weeklyReflection.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

console.log("=== weekly reflection entry-type privacy ===\n");

assert(
  WEEKLY_REFLECTION_USER_MARK_ENTRY_TYPE === "note",
  "user mark entry type must be note"
);
assert(isWeeklyReflectionVisibleEntryType("note"), "note should be visible");
assert(!isWeeklyReflectionVisibleEntryType("insight"), "insight must be private");
assert(!isWeeklyReflectionVisibleEntryType("tension"), "tension must be private");
assert(!isWeeklyReflectionVisibleEntryType("weekly"), "weekly snapshot must not feed generation");
assert(!isWeeklyReflectionVisibleEntryType("shift"), "shift must not feed generation");
assert(!isWeeklyReflectionVisibleEntryType("step"), "step must not feed generation");

console.log("All weeklyReflection privacy cases passed.");

console.log("\n=== buildWeeklyReflectionPrompt linked-pairs block ===\n");

const withPairs = buildWeeklyReflectionPrompt({
  title: "эта беседа", memory: null, transcript: [], userMarks: [], activeDays: 1,
  linkedPairs: [{ newClaim: "сменила работу", oldClaim: "боялась сменить работу" }],
});
assert(withPairs.includes("сменила работу"), "should include the new claim");
assert(withPairs.includes("боялась сменить работу"), "should include the old claim");
assert(/на ваше усмотрение/i.test(withPairs), "should leave attribution to the model's judgment");

const withoutPairs = buildWeeklyReflectionPrompt({
  title: "эта беседа", memory: null, transcript: [], userMarks: [], activeDays: 1,
  linkedPairs: [],
});
assert(!withoutPairs.includes("ПЕРЕМЕНЫ"), "should omit the block entirely when no pairs are passed");

console.log("All buildWeeklyReflectionPrompt linked-pairs cases passed.");

console.log("\n=== fetchLinkedPairsForConversation uses the service-role client ===\n");

// memory_v3_dialogue_items is REVOKE ALL ... FROM authenticated (migration
// 039) -- only service_role may read it. generateWeeklyReflectionText is
// called from weekly-reflection/index.ts with a user-JWT-scoped client
// (built from the caller's own bearer token), so a query against this table
// using THAT client always fails with a permissions error. This test proves
// fetchLinkedPairsForConversation builds its own service-role client
// (makeServiceClient() from cost.ts) instead of taking the caller's client,
// by capturing which key actually goes out on the wire.
{
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of new Headers(init.headers as HeadersInit).entries()) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({ url: String(url), headers });
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const pairs = await fetchLinkedPairsForConversation("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    assert(Array.isArray(pairs), "should return an array even for an empty result");
    assert(calls.length > 0, "should have issued at least one request");
    const call = calls.find((c) => c.url.includes("memory_v3_dialogue_items"));
    assert(!!call, "should query memory_v3_dialogue_items");
    const usedKey = call!.headers.apikey;
    assert(
      usedKey === "SERVICE_ROLE_SENTINEL_KEY",
      `should authenticate with the service-role key, got: ${usedKey}`,
    );
    assert(
      usedKey !== "ANON_SENTINEL_KEY",
      "must never use the caller's own anon/user-scoped key for this table",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("fetchLinkedPairsForConversation service-role case passed.");
