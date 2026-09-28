import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const lifeMemory = await readFile(
  new URL("../userLifeMemory.ts", import.meta.url),
  "utf8",
);
const summaryRefresh = await readFile(
  new URL("../summaryRefresh.ts", import.meta.url),
  "utf8",
);
const usageAnalytics = await readFile(
  new URL("../usageAnalytics.ts", import.meta.url),
  "utf8",
);
const context = await readFile(
  new URL("../context.ts", import.meta.url),
  "utf8",
);
const consolidation = await readFile(
  new URL("../consolidateUserLifeMemory.ts", import.meta.url),
  "utf8",
);

describe("legacy memory retirement wiring", () => {
  it("gates legacy user_memory before cross-memory reads and model calls", () => {
    const compat = lifeMemory.indexOf("fetchLegacyMemoryCompatibilityEnabled(");
    const crossMemory = lifeMemory.indexOf("fetchConversationCrossMemoryEnabled(", compat);
    const modelCall = lifeMemory.indexOf("/chat/completions", compat);
    assert.ok(compat >= 0);
    assert.ok(crossMemory > compat);
    assert.ok(modelCall > crossMemory);
    assert.match(lifeMemory, /if \(!legacyCompatibilityEnabled\) \{\s*return;\s*\}/u);
  });

  it("keeps conversation summaries while tagging both legacy costs explicitly", () => {
    assert.match(summaryRefresh, /runConversationSummaryRefresh/u);
    assert.match(usageAnalytics, /legacy_conversation_summary/u);
    assert.match(usageAnalytics, /legacy_cross_memory_synthesis/u);
  });

  it("does not inject stored legacy user_memory for ordinary Memory V3 profiles", () => {
    assert.match(context, /fetchLegacyMemoryCompatibilityEnabled\(supabase, input\.userId\)/u);
    assert.match(
      context,
      /crossMemoryOn && legacyMemoryCompatibilityEnabled\s*\? await fetchMemoryItems/u,
    );
  });

  it("gates legacy diagnostics and consolidation before reading user_memory", () => {
    const summaryCompat = summaryRefresh.indexOf(
      "fetchLegacyMemoryCompatibilityEnabled(",
    );
    const summaryRead = summaryRefresh.indexOf('.from("user_memory")');
    assert.ok(summaryCompat >= 0 && summaryRead > summaryCompat);
    assert.match(
      summaryRefresh,
      /if \(input\.userId && legacyMemoryCompatibilityEnabled\)/u,
    );

    const consolidateAllStart = consolidation.indexOf(
      "export async function consolidateAllUserLifeMemory(",
    );
    const consolidationCompat = consolidation.indexOf(
      "fetchLegacyMemoryCompatibilityEnabled(",
      consolidateAllStart,
    );
    const consolidationRead = consolidation.indexOf(
      '.from("user_memory")',
      consolidateAllStart,
    );
    assert.ok(consolidationCompat >= 0 && consolidationRead > consolidationCompat);
    assert.match(
      consolidation,
      /if \(!legacyMemoryCompatibilityEnabled\) return \[\];/u,
    );
  });
});
