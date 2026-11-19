/**
 * The write boundary of the cross-conversation memory, with the real refreshUserLifeMemory (found 20.11.2026).
 *
 * userLifeMemory.ts pulls `npm:` imports that plain Node/tsx cannot load, and its old test only searched the source text for
 * `importance: c.importance`: green while the value was really `undefined` (the filter had dropped it, the column default 3
 * was written). Here the real function runs against a recording fake of the database client; the model call is a local stub
 * (no network, no money). All people and phrases are made up.
 *
 * Run (from the repository root):
 *   deno test --no-check --allow-env --no-config --node-modules-dir=none supabase/functions/_shared/userLifeMemory.deno.test.ts
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { refreshUserLifeMemory } from "./userLifeMemory.ts";
import type { StructuredMemory } from "./memory.ts";

interface Recorded {
  table: string;
  row: Record<string, unknown>;
}

/** A client that answers the reads of this function and records every insert. */
function fakeClient(existingMemoryRows: Array<Record<string, unknown>> = []) {
  const inserts: Recorded[] = [];
  const updates: Recorded[] = [];
  let nextId = 1;

  /** What every read or write of the fake answers with. */
  interface Answer {
    data: unknown;
    error: null;
  }
  /** The chain the real code builds: .from().select().eq()... ending in await, .single() or .maybeSingle(). */
  interface Chain extends PromiseLike<Answer> {
    select(): Chain;
    eq(): Chain;
    in(): Chain;
    order(): Chain;
    limit(): Chain;
    insert(row: Record<string, unknown>): Chain;
    update(row: Record<string, unknown>): Chain;
    delete(): Chain;
    single(): Promise<Answer>;
    maybeSingle(): Promise<Answer>;
  }

  const from = (table: string): Chain => {
    let mode: "select" | "insert" | "update" | "delete" = "select";
    const result = (): Answer => {
      if (mode === "insert") return { data: { id: `new-row-${nextId++}` }, error: null };
      if (mode !== "select") return { data: null, error: null };
      if (table === "profiles") return { data: { legacy_memory_compat_enabled: true, cross_memory_enabled: true }, error: null };
      if (table === "user_memory") return { data: existingMemoryRows, error: null };
      return { data: [], error: null };
    };
    const chain: Chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      insert: (row: Record<string, unknown>) => {
        mode = "insert";
        inserts.push({ table, row });
        return chain;
      },
      update: (row: Record<string, unknown>) => {
        mode = "update";
        updates.push({ table, row });
        return chain;
      },
      delete: () => {
        mode = "delete";
        return chain;
      },
      single: () => Promise.resolve(result()),
      maybeSingle: () => Promise.resolve(result()),
      then: (onfulfilled, onrejected) => Promise.resolve(result()).then(onfulfilled, onrejected),
    };
    return chain;
  };

  return {
    client: { from } as unknown as SupabaseClient,
    userMemoryInserts: () => inserts.filter((i) => i.table === "user_memory").map((i) => i.row),
    userMemoryUpdates: () => updates.filter((u) => u.table === "user_memory").map((u) => u.row),
  };
}

function memoryWith(partial: Partial<StructuredMemory>): StructuredMemory {
  return {
    people: [],
    themes: [],
    emotional_state: [],
    important_events: [],
    preferences: [],
    risks: [],
    open_loops: [],
    last_updated: "2026-11-20T00:00:00.000Z",
    ...partial,
  };
}

const USER = "11111111-1111-4111-8111-111111111111";

Deno.test("rule-based candidates are written with their own importance (4 for a person, 5 for a way of talking)", async () => {
  const db = fakeClient();
  await refreshUserLifeMemory(
    db.client,
    USER,
    memoryWith({
      people: ["сын (18 лет)"],
      preferences: ["не нужны пустые успокаивающие фразы, нужно присутствие"],
    }),
  );

  const rows = db.userMemoryInserts();
  if (rows.length < 2) throw new Error(`expected 2 inserts into user_memory, got ${rows.length}`);
  const person = rows.find((r) => r.memory_type === "life_context");
  const talk = rows.find((r) => r.memory_type === "communication");
  if (!person || person.importance !== 4) throw new Error(`a person must be written with importance 4, got ${String(person?.importance)}`);
  if (!talk || talk.importance !== 5) throw new Error(`a way of talking must be written with importance 5, got ${String(talk?.importance)}`);
});

Deno.test("a candidate from the model keeps the importance of its type through the filter to the insert", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '[{"memory_type":"preference","content":"Нужно, чтобы со мной говорили прямо, без советов и оценок."}]' } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as typeof fetch;
  try {
    const db = fakeClient();
    await refreshUserLifeMemory(db.client, USER, memoryWith({}), {
      baseUrl: "https://model.invalid/v1",
      model: "fake/model",
      apiKey: "test-key-not-real",
    });
    const rows = db.userMemoryInserts();
    const preference = rows.find((r) => r.memory_type === "preference");
    if (!preference) throw new Error(`the model candidate was not written, inserts: ${JSON.stringify(rows)}`);
    if (preference.importance !== 5) throw new Error(`a preference from the model must be written with importance 5, got ${String(preference.importance)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("every insert carries a whole importance from 1 to 5, never an empty value", async () => {
  const db = fakeClient();
  await refreshUserLifeMemory(
    db.client,
    USER,
    memoryWith({
      people: ["кошка Муся"],
      important_events: ["сын съехал на съёмную квартиру"],
      preferences: ["обращаться ко мне в женском роде"],
    }),
  );
  const rows = db.userMemoryInserts();
  if (rows.length === 0) throw new Error("nothing was written");
  for (const row of rows) {
    const v = row.importance;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) {
      throw new Error(`importance of "${String(row.content)}" is ${String(v)}`);
    }
  }
});
