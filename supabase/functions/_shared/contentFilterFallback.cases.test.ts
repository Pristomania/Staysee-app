/**
 * Run: npx tsx supabase/functions/_shared/contentFilterFallback.cases.test.ts
 * An answer that the provider's content filter withheld is a failed attempt: the next model in the chain answers.
 * Read from the source of the chat function (the function cannot be started here).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const chat = readFileSync(resolve("supabase/functions/staysee-chat/index.ts"), "utf8").replace(/\r/g, "");

const finish = chat.indexOf('const finishReason: string | undefined = data.choices?.[0]?.finish_reason;');
const filter = chat.indexOf('if (finishReason === "content_filter") {');
const empty = chat.indexOf("if (!content) {");
assert(finish > 0 && filter > finish, "the finish reason is read first, then the content filter is checked");
assert(empty > filter, "the content filter is checked before a non-empty answer is accepted");
const block = chat.slice(filter, empty);
assert(/return null;/.test(block), "a withheld answer is a failed attempt (return null), so the fallback model answers");
assert(/fallbackModelOverride && fallbackModelOverride !== primaryModel/.test(chat), "the fallback model is tried after the primary one fails");

console.log("All contentFilterFallback cases passed.");
