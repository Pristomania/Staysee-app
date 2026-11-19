/**
 * The write of the consolidation of cross-memory rows keeps the importance (found 20.11.2026, same defect as userLifeMemory).
 * The filter used to drop importance, a cast (`as typeof toInsert`) hid it, and the insert wrote `importance: undefined`
 * (the column default 3). The real function runs against a recording fake of the database client; the model is a local stub
 * (no network, no money). All data is made up.
 *
 * Run (from the repository root):
 *   deno test --no-check --allow-env --no-config --node-modules-dir=none supabase/functions/_shared/consolidateUserLifeMemory.deno.test.ts
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { consolidateUserLifeMemoryRows, type UserMemoryRow } from "./consolidateUserLifeMemory.ts";

interface Answer {
  data: unknown;
  error: null;
}

interface DeleteChain extends PromiseLike<Answer> {
  in(): DeleteChain;
}

function fakeClient() {
  const inserts: Array<Record<string, unknown>> = [];
  const deletes: string[] = [];
  const client = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        if (table === "user_memory") inserts.push(row);
        return Promise.resolve({ data: null, error: null } as Answer);
      },
      delete: () => {
        deletes.push(table);
        const chain: DeleteChain = {
          in: () => chain,
          then: (onfulfilled, onrejected) => Promise.resolve({ data: null, error: null } as Answer).then(onfulfilled, onrejected),
        };
        return chain;
      },
    }),
  } as unknown as SupabaseClient;
  return { client, inserts, deletes };
}

const USER = "11111111-1111-4111-8111-111111111111";

function row(id: string, content: string): UserMemoryRow {
  return { id, user_id: USER, memory_type: "life_context", content };
}

Deno.test("consolidated rows from the model are written with a whole importance, not left to the column default", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '[{"memory_type":"life_context","content":"У пользователя есть сын 18 лет и кошка Муся."}]' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as typeof fetch;
  try {
    const db = fakeClient();
    const result = await consolidateUserLifeMemoryRows(
      db.client,
      USER,
      [row("row-1", "сын"), row("row-2", "кошка")],
      { baseUrl: "https://model.invalid/v1", model: "fake/model", apiKey: "test-key-not-real" },
    );
    if (result.added !== 1) throw new Error(`expected 1 row added, got ${JSON.stringify(result)}`);
    if (db.inserts.length !== 1) throw new Error(`expected 1 insert, got ${db.inserts.length}`);
    const v = db.inserts[0]!.importance;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) throw new Error(`importance written: ${String(v)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("consolidated rows built by rules keep their importance as well", async () => {
  const db = fakeClient();
  const result = await consolidateUserLifeMemoryRows(
    db.client,
    USER,
    [row("row-1", "У пользователя есть сын 18 лет."), row("row-2", "У пользователя есть кошка Муся.")],
    undefined,
    false,
    true,
  );
  if (result.added < 1) throw new Error(`nothing was added: ${JSON.stringify(result)}`);
  for (const r of db.inserts) {
    const v = r.importance;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) throw new Error(`importance of "${String(r.content)}": ${String(v)}`);
  }
});
