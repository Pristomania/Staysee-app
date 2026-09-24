import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReadableReport } from "./dialogue-history-backfill-report.ts";

describe("dialogue history backfill readable report", () => {
  it("lists each succeeded conversation's items with Russian topic labels", () => {
    const report = buildReadableReport({
      benchmarkResult: {
        conversations: [
          {
            conversationId: "convo-1",
            failureCount: 0,
            expectedStateRevision: 0,
            finalState: { items: [{ claim: "Живёт в Казани", topic: "fact" }, { claim: "Любит утренние прогулки", topic: "preference" }] },
          },
        ],
      },
    });
    assert.match(report, /Диалог convo-1 \(диалог был пустым\):/);
    assert.match(report, /\[Факты\] Живёт в Казани/);
    assert.match(report, /\[Предпочтения общения\] Любит утренние прогулки/);
  });

  it("labels a conversation that already had live data as replaced, not indistinguishable from an empty one", () => {
    const report = buildReadableReport({
      benchmarkResult: {
        conversations: [
          {
            conversationId: "convo-active",
            failureCount: 0,
            expectedStateRevision: 6,
            finalState: { items: [{ claim: "Работает психологом", topic: "fact" }] },
          },
        ],
      },
    });
    assert.match(report, /Из них с заменой уже накопленной памяти: 1/);
    assert.match(report, /Диалог convo-active \(в этом диалоге уже была своя память -- она заменена этим разбором\):/);
  });

  it("names failed conversations explicitly", () => {
    const report = buildReadableReport({
      benchmarkResult: {
        conversations: [{ conversationId: "convo-fail", failureCount: 1, expectedStateRevision: 0, finalState: null }],
      },
    });
    assert.match(report, /Не удалось разобрать: 1/);
    assert.match(report, /convo-fail/);
  });

  it("handles a conversation with zero surviving items without crashing", () => {
    const report = buildReadableReport({
      benchmarkResult: {
        conversations: [{ conversationId: "convo-empty", failureCount: 0, expectedStateRevision: 0, finalState: { items: [] } }],
      },
    });
    assert.match(report, /ничего устойчивого не найдено/);
  });
});
