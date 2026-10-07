import assert from "node:assert/strict";
import { register } from "node:module";

// memory.ts (and its transitive Edge imports, e.g. cost.ts) use Deno-style
// `npm:` specifiers. Remap them to bare package names so local tsx can load
// updateConversationSummary without changing production code or
// package.json -- same pattern as cost.cases.test.ts.
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
const g = globalThis as typeof globalThis & {
  Deno?: { env: { get: (key: string) => string | undefined } };
};
if (!g.Deno) {
  g.Deno = {
    env: {
      get() {
        return undefined;
      },
    },
  };
}

const { updateConversationSummary } = await import("./memory.ts");
import type { StructuredMemory } from "./memory.ts";

function emptyMemory(overrides: Partial<StructuredMemory> = {}): StructuredMemory {
  return {
    people: [],
    themes: [],
    emotional_state: [],
    important_events: [],
    preferences: [],
    risks: [],
    open_loops: [],
    last_updated: new Date().toISOString(),
    ...overrides,
  };
}

function fakeSupabase() {
  const updates: Array<{ table: string; payload: Record<string, unknown>; id: string }> = [];
  const supabase = {
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          return {
            async eq(_column: string, id: string) {
              updates.push({ table, payload, id });
              return { error: null };
            },
          };
        },
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  // The post-write read-back in updateConversationSummary
                  // only affects its own reported byte count, not the
                  // payload this test cares about -- a conversation_summary
                  // long enough to make `ok` true either way keeps the
                  // assertions focused on the emotional_tone field.
                  return { data: { conversation_summary: "x".repeat(10), summary: null }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { supabase: supabase as never, updates };
}

await (async () => {
  // Regression coverage: extractEmotionalToneFromMemory has always
  // correctly derived a tone from the model's own emotional_state output,
  // but updateConversationSummary computed it into a local `tone` variable
  // and then never put it in the update payload -- the column it would
  // have gone to (conversations.emotional_tone) also never existed in
  // production until migration 070, so this had no visible failure mode
  // beyond "the feature silently does nothing," which is exactly how it
  // went unnoticed.
  const { supabase, updates } = fakeSupabase();
  const result = await updateConversationSummary({
    supabase,
    conversationId: "11111111-1111-1111-1111-111111111111",
    memory: emptyMemory({ emotional_state: ["тревожно, но с надеждой"] }),
  });

  assert.equal(result.ok, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].table, "conversations");
  assert.equal(updates[0].payload.emotional_tone, "тревожно, но с надеждой");

  console.log("PASS: updateConversationSummary writes the computed emotional tone to the update payload");
})();

await (async () => {
  // An explicitly passed emotionalTone wins over one derived from memory.
  const { supabase, updates } = fakeSupabase();
  await updateConversationSummary({
    supabase,
    conversationId: "11111111-1111-1111-1111-111111111111",
    emotionalTone: "спокойно",
    memory: emptyMemory({ emotional_state: ["тревожно"] }),
  });

  assert.equal(updates[0].payload.emotional_tone, "спокойно");
  console.log("PASS: an explicitly provided emotionalTone is not overridden by one derived from memory");
})();

await (async () => {
  // No tone at all (empty memory arrays, nothing explicit) writes null,
  // not undefined -- undefined would be dropped from a real Supabase
  // update payload instead of clearing a stale value.
  const { supabase, updates } = fakeSupabase();
  await updateConversationSummary({
    supabase,
    conversationId: "11111111-1111-1111-1111-111111111111",
    memory: emptyMemory({ themes: ["работа"] }),
  });

  assert.equal(updates[0].payload.emotional_tone, "работа");
  console.log("PASS: falls back to the first theme when emotional_state is empty, matching extractEmotionalToneFromMemory");
})();

console.log("memorySummaryTone.cases.test.ts — all passed");
