import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { estimateTokens } from "./tokenEstimate.ts";

test("estimateTokens keeps cost.ts's chars/3.5 round-up rule", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("я".repeat(700)), 200);
  assert.equal(estimateTokens("x".repeat(701)), 201);
});

test("cost.ts re-exports the one shared implementation instead of keeping its own copy", () => {
  const source = readFileSync(new URL("./cost.ts", import.meta.url), "utf8");
  assert.match(source, /export \{ estimateTokens \} from "\.\/tokenEstimate\.ts";/);
  assert.doesNotMatch(source, /function estimateTokens/);
});

test("tokenEstimate.ts stays dependency-free so Node-run Memory V3 modules can import it", () => {
  const source = readFileSync(new URL("./tokenEstimate.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bDeno\./);
});
