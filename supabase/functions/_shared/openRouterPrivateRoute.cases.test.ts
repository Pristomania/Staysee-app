import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { OPENROUTER_PRIVATE_ROUTE } from "./openRouterPrivateRoute.ts";

// Found on 31.10: only some model calls asked OpenRouter for a route that keeps nothing. The main reply, the
// conversation summary, the embeddings, the weekly reflection and the older memory jobs carried what a person wrote
// without it, and GPT-4o replies went to OpenAI itself in about a third of the cases. Measured the same day: the
// private route costs the same per token (GPT-4o on Azure, Sonnet on Amazon Bedrock).

const functionsDir = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

const read = (relative: string) => readFileSync(join(functionsDir, relative), "utf8").split("\r\n").join("\n");

describe("the private route for model requests", () => {
  it("asks for endpoints that keep nothing and do not train", () => {
    assert.deepEqual({ ...OPENROUTER_PRIVATE_ROUTE }, { data_collection: "deny", zdr: true });
  });

  it("is on every file that sends a request to a model endpoint", () => {
    // A URL ending in /chat/completions or /embeddings inside quotes: a request, not a mention in a comment.
    const sendsRequest = /\/(chat\/completions|embeddings)[`"']/;
    const files = sourceFiles(functionsDir).filter((path) => sendsRequest.test(readFileSync(path, "utf8")));
    assert.ok(files.length >= 10, `expected to find the model callers, found ${files.length}`);
    const without = files
      .filter((path) => !/data_collection|OPENROUTER_PRIVATE_ROUTE/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(functionsDir.length).split("\\").join("/"));
    // The long-message summary sends the request that longMessages.ts builds, and that one carries it (checked below).
    assert.deepEqual(without.filter((path) => path !== "_shared/longMessageSummarizer.ts"), [], "these files send a request without the private route");
  });

  it("is on the long-message summary, whose request is built in another file", () => {
    assert.match(read("_shared/longMessageSummarizer.ts"), /body: JSON\.stringify\(buildLongMessageSummaryRequest\(/);
    assert.match(read("_shared/longMessages.ts"), /data_collection: "deny", zdr: true/);
  });

  it("goes only to OpenRouter in the calls that may also reach another provider", () => {
    const chat = read("staysee-chat/index.ts");
    assert.match(chat, /provider === "openrouter" \? \{ provider: OPENROUTER_PRIVATE_ROUTE \} : \{\}/);
    const structured = read("_shared/structuredModelCall.ts");
    assert.match(structured, /input\.primaryProvider === "openrouter" \? \{ provider: OPENROUTER_PRIVATE_ROUTE \} : \{\}/);
    const embeddings = read("_shared/embeddings.ts");
    assert.match(embeddings, /baseUrl\.includes\("openrouter\.ai"\) \? \{ provider: OPENROUTER_PRIVATE_ROUTE \} : \{\}/);
  });

  it("sits in the body of each remaining request, next to the model", () => {
    for (const relative of [
      "_shared/summaryRefresh.ts",
      "_shared/userLifeMemory.ts",
      "_shared/consolidateUserLifeMemory.ts",
      "_shared/backfillMemory.ts",
      "_shared/weeklyReflection.ts",
      "_shared/semanticCrisisCheck.ts",
    ]) {
      assert.match(read(relative), /provider: OPENROUTER_PRIVATE_ROUTE,/, relative);
    }
  });
});
