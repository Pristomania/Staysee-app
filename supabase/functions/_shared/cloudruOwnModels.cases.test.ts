/**
 * The app asks Cloud.ru only for models Cloud.ru hosts itself (the owner's rule: a partner model sends the text outside it).
 * Run: npx tsx --test supabase/functions/_shared/cloudruOwnModels.cases.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { CLOUDRU_ALLOWED_PARTNER_RESERVES, CLOUDRU_OWN_MODELS, isAllowedCloudruModel } from "../../../scripts/lib/cloudru-models.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Names the way Cloud.ru writes its models (OpenRouter writes the same makers in lower case: "deepseek/…", "qwen/…"). */
const CLOUDRU_NAME = /["'`]((?:deepseek-ai|moonshotai\/Kimi|Qwen|BAAI|zai-org|GigaChat|ai-sage|MiniMaxAI)[A-Za-z0-9._/-]*|openai\/gpt-oss-[A-Za-z0-9._-]+)["'`]/g;

describe("models the app asks of Cloud.ru", () => {
  it("are all hosted by Cloud.ru itself, or allowed by name as a reserve", () => {
    const found: string[] = [];
    for (const path of sources(root)) {
      // The price table names models only to count what a measurement cost.
      if (path.endsWith("openRouterPricing.ts")) continue;
      for (const match of readFileSync(path, "utf8").matchAll(CLOUDRU_NAME)) {
        found.push(match[1]);
        assert.ok(isAllowedCloudruModel(match[1]), `${match[1]} in ${path.slice(root.length)} is not a model Cloud.ru hosts itself`);
      }
    }
    for (const used of ["deepseek-ai/DeepSeek-V4-Pro", "openai/gpt-oss-120b", "BAAI/bge-m3", "BAAI/bge-reranker-v2-m3", "Qwen/Qwen3.5-397B-A17B", "Qwen/Qwen3.6-35B-A3B"]) {
      assert.ok(found.includes(used), `the check sees ${used}`);
    }
  });

  it("no partner reserve is allowed yet, and the lists do not overlap", () => {
    assert.deepEqual([...CLOUDRU_ALLOWED_PARTNER_RESERVES], []);
    assert.equal(isAllowedCloudruModel("deepseek-ai/DeepSeek-V4.1-Flash"), false);
    assert.equal(isAllowedCloudruModel(undefined), false);
    for (const model of CLOUDRU_ALLOWED_PARTNER_RESERVES) assert.ok(!CLOUDRU_OWN_MODELS.includes(model));
  });
});
