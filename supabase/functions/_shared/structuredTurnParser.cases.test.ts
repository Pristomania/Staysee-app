/**
 * Structured turn parser — unit cases.
 * Run: npx tsx supabase/functions/_shared/structuredTurnParser.cases.test.ts
 */

import {
  buildStructuredTurnJsonSchema,
  FORBIDDEN_KEYS,
} from "./structuredTurnSchema.ts";
import { parseStructuredTurn } from "./structuredTurnParser.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function validTurn(overrides: Record<string, unknown> = {}) {
  return {
    processState: {
      contact: "active",
      movement: "opening",
      closure: "system_should_not_close",
      certainty: "low",
      ...(overrides.processState as object),
    },
    openFigure: {
      isOpen: true,
      kind: "emotional",
      intensity: "medium",
      confidence: "low",
      ...(overrides.openFigure as object),
    },
    response: "Похоже, сейчас непросто. Что для тебя самое тяжёлое?",
    ...overrides,
  };
}

function expectOk(name: string, raw: string) {
  const result = parseStructuredTurn(raw);
  assert(result.ok === true, `${name}: expected ok=true, got ${JSON.stringify(result)}`);
  console.log(`✓ ${name}`);
  return result.ok ? result.turn : null;
}

function expectFail(
  name: string,
  raw: string,
  reason: string
) {
  const result = parseStructuredTurn(raw);
  assert(result.ok === false, `${name}: expected ok=false`);
  if (!result.ok) {
    assert(result.reason === reason, `${name}: reason ${result.reason} !== ${reason}`);
  }
  console.log(`✓ ${name}`);
}

// 1. valid minimal JSON
expectOk("valid minimal JSON", JSON.stringify(validTurn()));

// 2. markdown-wrapped JSON
expectOk(
  "markdown-wrapped JSON",
  "```json\n" + JSON.stringify(validTurn()) + "\n```"
);

// 3. invalid JSON
expectFail("invalid JSON", "{not json", "invalid_json");

// 4. plain text only
expectFail("plain text only", "Просто ответ без JSON.", "invalid_json");

// 5. extra top-level field rejected
expectFail(
  "extra top-level field rejected",
  JSON.stringify({ ...validTurn(), extra: true }),
  "schema_violation"
);

// 6. extra nested processState field rejected
expectFail(
  "extra nested processState field rejected",
  JSON.stringify(
    validTurn({
      processState: {
        contact: "active",
        movement: "opening",
        closure: "system_should_not_close",
        certainty: "low",
        note: "hidden",
      },
    })
  ),
  "schema_violation"
);

// 7. extra nested openFigure field rejected
expectFail(
  "extra nested openFigure field rejected",
  JSON.stringify(
    validTurn({
      openFigure: {
        isOpen: true,
        kind: "emotional",
        intensity: "medium",
        confidence: "low",
        trigger: "short_emotional",
      },
    })
  ),
  "schema_violation"
);

// 8. reasoning field rejected
expectFail(
  "reasoning field rejected",
  JSON.stringify({ ...validTurn(), reasoning: "because user is sad" }),
  "forbidden_field"
);

// 9. diagnosis field rejected
expectFail(
  "diagnosis field rejected",
  JSON.stringify({
    ...validTurn(),
    processState: {
      contact: "active",
      movement: "opening",
      closure: "none",
      certainty: "low",
      diagnosis: "anxiety",
    },
  }),
  "forbidden_field"
);

// 10. evidence field rejected
expectFail(
  "evidence field rejected",
  JSON.stringify({
    ...validTurn(),
    openFigure: {
      isOpen: true,
      kind: "body",
      intensity: "high",
      confidence: "medium",
      evidence: ["устала"],
    },
  }),
  "forbidden_field"
);

// 11. attachment/style key rejected
expectFail(
  "attachment key rejected",
  JSON.stringify({ ...validTurn(), attachment: "anxious" }),
  "forbidden_field"
);

expectFail(
  "avoidantStyle key rejected",
  JSON.stringify({ ...validTurn(), avoidantStyle: true }),
  "forbidden_field"
);

// 12. missing response
expectFail(
  "missing response",
  JSON.stringify({
    processState: validTurn().processState,
    openFigure: validTurn().openFigure,
  }),
  "missing_response"
);

// 13. empty response
expectFail(
  "empty response",
  JSON.stringify(validTurn({ response: "   " })),
  "response_empty"
);

// 14. too long response
expectFail(
  "too long response",
  JSON.stringify(validTurn({ response: "а".repeat(4001) })),
  "response_too_long"
);

// 15. response contains JSON leak
expectFail(
  "response contains JSON leak",
  JSON.stringify(
    validTurn({
      response: '{"processState":{"contact":"active"},"response":"hi"}',
    })
  ),
  "response_contains_json"
);

// 16. invalid enum rejected
expectFail(
  "invalid enum rejected",
  JSON.stringify(
    validTurn({
      processState: {
        contact: "avoidant",
        movement: "opening",
        closure: "none",
        certainty: "low",
      },
    })
  ),
  "schema_violation"
);

// 17. response mentioning openFigure/processState internal structure
expectFail(
  "response leaks internal structure",
  JSON.stringify(
    validTurn({
      response: 'Debug: "openFigure": {"isOpen": true} in payload',
    })
  ),
  "response_contains_json"
);

// Schema invariants
const schema = buildStructuredTurnJsonSchema();
const schemaStr = JSON.stringify(schema);

assert(!schemaStr.includes('"reasoning"'), "schema must not include reasoning field");
assert(!schemaStr.includes('"evidence"'), "schema must not include evidence field");
assert(!schemaStr.includes('"reason"'), "schema must not include freeform reason field");
assert(FORBIDDEN_KEYS.has("reasoning"), "FORBIDDEN_KEYS includes reasoning");
assert(FORBIDDEN_KEYS.has("evidence"), "FORBIDDEN_KEYS includes evidence");
console.log("✓ schema has no reasoning/evidence/reason fields");

const parsed = parseStructuredTurn(JSON.stringify(validTurn()));
assert(parsed.ok === true, "sanity parse");
if (parsed.ok) {
  assert(parsed.turn.response.length >= 1, "response length");
  assert(parsed.turn.processState.contact === "active", "contact enum");
  assert(parsed.turn.openFigure.isOpen === true, "openFigure boolean");
}
console.log("✓ sanity typed turn");

console.log("\nAll structuredTurnParser cases passed.");
