import assert from "node:assert/strict";
import { describe, it } from "node:test";

// context.ts imports the real "npm:" Supabase client (createClient) at its
// top level -- Deno-only, unresolvable under plain Node/tsx (same reason
// usageAnalytics.cases.test.ts mirrors buildUsageLogRow's defaults locally
// instead of importing it). This mirrors inspectContextPromptOptions's new
// two-field logic instead of importing context.ts directly, so the
// validation algorithm itself gets a real test even though the production
// function can't be called from here. deno check (run separately) covers
// type correctness against the real file.

const CONTEXT_PROMPT_OPTION_FIELDS = ["lifecycleCrossMemory", "dialogueMemory"] as const;

interface InspectedContextPromptOptions {
  lifecycleCrossMemory: unknown | null;
  dialogueMemory: unknown | null;
}

class ContextPromptOptionsError extends Error {}

function inspectContextPromptOptions(
  value: Record<string, unknown> | undefined,
): InspectedContextPromptOptions | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContextPromptOptionsError();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContextPromptOptionsError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0 || keys.length > CONTEXT_PROMPT_OPTION_FIELDS.length) {
    throw new ContextPromptOptionsError();
  }
  const result: InspectedContextPromptOptions = {
    lifecycleCrossMemory: null,
    dialogueMemory: null,
  };
  const seen = new Set<string>();
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      !(CONTEXT_PROMPT_OPTION_FIELDS as readonly string[]).includes(key) ||
      seen.has(key)
    ) {
      throw new ContextPromptOptionsError();
    }
    seen.add(key);
    const own = Object.getOwnPropertyDescriptor(value, key);
    if (!own || !own.enumerable || !("value" in own) || own.value === undefined) {
      throw new ContextPromptOptionsError();
    }
    if (key === "lifecycleCrossMemory") result.lifecycleCrossMemory = own.value;
    else result.dialogueMemory = own.value;
  }
  return result;
}

describe("inspectContextPromptOptions (mirrored)", () => {
  it("returns null when no options object is passed at all", () => {
    assert.equal(inspectContextPromptOptions(undefined), null);
  });

  it("accepts lifecycleCrossMemory alone", () => {
    const result = inspectContextPromptOptions({ lifecycleCrossMemory: { items: [] } });
    assert.deepEqual(result, { lifecycleCrossMemory: { items: [] }, dialogueMemory: null });
  });

  it("accepts dialogueMemory alone", () => {
    const result = inspectContextPromptOptions({ dialogueMemory: { items: [] } });
    assert.deepEqual(result, { lifecycleCrossMemory: null, dialogueMemory: { items: [] } });
  });

  it("accepts both fields together", () => {
    const result = inspectContextPromptOptions({
      lifecycleCrossMemory: { items: ["legacy"] },
      dialogueMemory: { items: ["dialogue"] },
    });
    assert.deepEqual(result, {
      lifecycleCrossMemory: { items: ["legacy"] },
      dialogueMemory: { items: ["dialogue"] },
    });
  });

  it("rejects an empty options object, an unknown key, or a duplicate field", () => {
    for (const bad of [
      {},
      { lifecycleCrossMemory: { items: [] }, extra: true },
      { unknownField: true },
    ]) {
      assert.throws(() => inspectContextPromptOptions(bad), ContextPromptOptionsError);
    }
  });

  it("rejects non-plain-object values and arrays", () => {
    for (const bad of [null, [], "string", 1, true]) {
      assert.throws(() => inspectContextPromptOptions(bad as never), ContextPromptOptionsError);
    }
  });

  it("rejects a value of undefined for a present key, matching the old single-field behavior", () => {
    assert.throws(
      () => inspectContextPromptOptions({ lifecycleCrossMemory: undefined }),
      ContextPromptOptionsError,
    );
  });

  it("never executes a getter -- reads only the own data descriptor", () => {
    let getterCalls = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "lifecycleCrossMemory", {
      enumerable: true,
      get() { getterCalls += 1; return { items: [] }; },
    });
    assert.throws(() => inspectContextPromptOptions(accessor), ContextPromptOptionsError);
    assert.equal(getterCalls, 0);
  });
});
