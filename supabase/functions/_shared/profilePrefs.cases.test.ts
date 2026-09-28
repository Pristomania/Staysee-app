import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  fetchConversationCrossMemoryEnabled,
} from "./profilePrefs.ts";

type RowResult = {
  data: { cross_memory_enabled: boolean | null } | null;
  error: { message: string } | null;
};

function preferenceClient(results: {
  conversation: RowResult;
  profile?: RowResult;
}) {
  const calls: Array<{ table: string; filters: Array<[string, string]> }> = [];

  const client = {
    from(table: string) {
      const call = { table, filters: [] as Array<[string, string]> };
      calls.push(call);
      const query = {
        select() {
          return query;
        },
        eq(field: string, value: string) {
          call.filters.push([field, value]);
          return query;
        },
        async maybeSingle() {
          return table === "conversations"
            ? results.conversation
            : results.profile ?? {
              data: { cross_memory_enabled: true },
              error: null,
            };
        },
      };
      return query;
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe("fetchConversationCrossMemoryEnabled", () => {
  it("returns the owned conversation value without consulting the profile default", async () => {
    const { client, calls } = preferenceClient({
      conversation: { data: { cross_memory_enabled: true }, error: null },
      profile: { data: { cross_memory_enabled: false }, error: null },
    });

    assert.equal(
      await fetchConversationCrossMemoryEnabled(client, "user-1", "conversation-1"),
      true,
    );
    assert.deepEqual(calls, [{
      table: "conversations",
      filters: [["id", "conversation-1"], ["user_id", "user-1"]],
    }]);
  });

  it("returns false for a disabled owned conversation", async () => {
    const { client } = preferenceClient({
      conversation: { data: { cross_memory_enabled: false }, error: null },
    });

    assert.equal(
      await fetchConversationCrossMemoryEnabled(client, "user-1", "conversation-1"),
      false,
    );
  });

  it("falls back to the profile default without leaking a raw database error", async () => {
    const { client, calls } = preferenceClient({
      conversation: {
        data: null,
        error: { message: "SUPER_SECRET_DATABASE_MESSAGE" },
      },
      profile: { data: { cross_memory_enabled: false }, error: null },
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      assert.equal(
        await fetchConversationCrossMemoryEnabled(client, "user-1", "conversation-1"),
        false,
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(calls.map((call) => call.table), ["conversations", "profiles"]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes("SUPER_SECRET_DATABASE_MESSAGE"), false);
  });
});
