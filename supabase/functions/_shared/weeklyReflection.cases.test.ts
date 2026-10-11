/**
 * Weekly reflection: personal notes (Записки себе) must never enter
 * generation input; confirmed Memory V3 facts/patterns do, minus sensitive ones.
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
const {
  buildWeeklyReflectionPrompt,
  fetchLinkedPairsForConversation,
  fetchConfirmedMemoryForConversation,
} = await import("./weeklyReflection.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

console.log("=== personal notes (Записки себе) can never reach this module ===\n");

// Насте: "Записки себе" (Инсайт/Точка напряжения) explicitly tells the user
// "не для чата со StaySee" -- this file must never read progress_entries at
// all (not filtered by entry_type, not read anywhere), so that promise can
// never be silently broken by a future refactor. A source-text check, not
// just a behavioral one, because the whole point is that the capability to
// read personal notes should not exist in this file at all.
{
  const nodeFs = (await import(/* @vite-ignore */ "node:fs/promises" as string)) as {
    readFile: (path: URL, encoding: string) => Promise<string>;
  };
  const source = await nodeFs.readFile(new URL("./weeklyReflection.ts", import.meta.url), "utf8");
  assert(!source.includes("progress_entries"), "must never query progress_entries (personal notes live there)");
  assert(!source.includes("userMarks"), "the old user-marks mechanism must be fully removed, not just disconnected");
  assert(!source.includes("weeklyReflectionPrivacy"), "must not import the old note-type allowlist at all");
}

console.log("All personal-notes exclusion cases passed.");

console.log("\n=== fetchConfirmedMemoryForConversation ===\n");

{
  const originalFetch = globalThis.fetch;
  const rows = [
    { kind: "event", claim: "Нормальный активный факт", status: "active", sensitivity: "normal", alternative: null },
    { kind: "event", claim: "Чувствительный факт — не должен попасть", status: "active", sensitivity: "sensitive", alternative: null },
    { kind: "recurrence", claim: "Активный паттерн", status: "active", sensitivity: "normal", alternative: null },
    { kind: "recurrence", claim: "Кандидат, не подтверждён", status: "candidate", sensitivity: "normal", alternative: null },
    { kind: "hypothesis", claim: "Подтверждённая гипотеза", status: "supported", sensitivity: "normal", alternative: "Альтернативное объяснение" },
    { kind: "hypothesis", claim: "Неподтверждённая гипотеза", status: "candidate", sensitivity: "normal", alternative: "Альт" },
  ];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } })
  ) as typeof fetch;

  try {
    const items = await fetchConfirmedMemoryForConversation("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    assert(items.length === 3, `should keep only active events/recurrences and supported hypotheses, got ${items.length}`);
    assert(!items.some((i) => i.claim.includes("Чувствительный")), "must exclude sensitive items");
    assert(!items.some((i) => i.claim.includes("Кандидат")), "must exclude non-active recurrence candidates");
    assert(!items.some((i) => i.claim.includes("Неподтверждённая")), "must exclude unconfirmed hypotheses");
    assert(items.some((i) => i.claim === "Подтверждённая гипотеза" && i.alternative === "Альтернативное объяснение"),
      "should keep the supported hypothesis with its alternative");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  // Same service-role-client proof as fetchLinkedPairsForConversation --
  // memory_v3_dialogue_items is REVOKE ALL ... FROM authenticated, so this
  // must never use the caller's own client.
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
    const items = await fetchConfirmedMemoryForConversation("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    assert(Array.isArray(items), "should return an array even for an empty result");
    const call = calls.find((c) => c.url.includes("memory_v3_dialogue_items"));
    assert(!!call, "should query memory_v3_dialogue_items");
    assert(call!.headers.apikey === "SERVICE_ROLE_SENTINEL_KEY", "must use the service-role key");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("All fetchConfirmedMemoryForConversation cases passed.");

console.log("\n=== buildWeeklyReflectionPrompt confirmed-memory block ===\n");

const withConfirmed = buildWeeklyReflectionPrompt({
  title: "эта беседа", memory: null, transcript: [], activeDays: 1,
  confirmedMemory: [
    { kind: "event", claim: "Сменила работу", alternative: null },
    { kind: "hypothesis", claim: "Юмор помогает", alternative: "Юмор помогает другим" },
  ],
  linkedPairs: [],
});
assert(withConfirmed.includes("Сменила работу"), "should include a confirmed event claim");
assert(withConfirmed.includes("Юмор помогает") && withConfirmed.includes("Юмор помогает другим"),
  "should include a supported hypothesis with its alternative");

const withoutConfirmed = buildWeeklyReflectionPrompt({
  title: "эта беседа", memory: null, transcript: [], activeDays: 1,
  confirmedMemory: [],
  linkedPairs: [],
});
assert(withoutConfirmed.includes("Подтверждённых фактов пока нет"), "should show the empty-state line when there is nothing confirmed yet");

console.log("All buildWeeklyReflectionPrompt confirmed-memory cases passed.");

console.log("\n=== buildWeeklyReflectionPrompt linked-pairs block ===\n");

const withPairs = buildWeeklyReflectionPrompt({
  title: "эта беседа", memory: null, transcript: [], activeDays: 1, confirmedMemory: [],
  linkedPairs: [{ newClaim: "сменила работу", oldClaim: "боялась сменить работу" }],
});
assert(withPairs.includes("сменила работу"), "should include the new claim");
assert(withPairs.includes("боялась сменить работу"), "should include the old claim");
assert(/на ваше усмотрение/i.test(withPairs), "should leave attribution to the model's judgment");

const withoutPairs = buildWeeklyReflectionPrompt({
  title: "эта беседа", memory: null, transcript: [], activeDays: 1, confirmedMemory: [],
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
