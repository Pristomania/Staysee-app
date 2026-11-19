/**
 * Cross-memory candidates keep their importance all the way to the write (found 20.11.2026).
 * Run: npx tsx supabase/functions/_shared/crossMemoryImportance.cases.test.ts
 *
 * The filter used to rebuild every candidate from memory_type + content only, so importance (4 for a fact about a person,
 * 5 for a preference) vanished; the casts `as CrossMemoryCandidate[]` hid it from the compiler. The insert then sent
 * importance: undefined, and the column default (3) was written. All data below is made up.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCrossMemoryCandidates,
  CROSS_MEMORY_TYPE_IMPORTANCE,
  resolveCandidateImportance,
} from "./crossMemoryBuild.ts";
import { filterCrossMemoryCandidates } from "./crossMemoryPolicy.ts";

describe("the filter keeps what the candidate carries", () => {
  it("an accepted candidate keeps importance 4 (the fixture of the report) and gets its content normalized", () => {
    const candidates = [{ memory_type: "life_context", content: "У пользователя есть сын 18 лет", importance: 4 }];
    const filtered = filterCrossMemoryCandidates(candidates);
    assert.equal(filtered.length, 1, "the candidate must pass");
    assert.deepEqual(filtered[0], {
      memory_type: "life_context",
      content: "У пользователя есть сын 18 лет.",
      importance: 4,
    });
  });

  it("a display prefix is still cut from the content, and the importance stays", () => {
    const [kept] = filterCrossMemoryCandidates([
      { memory_type: "life_context", content: "В жизни пользователя значимы люди: сын 18 лет", importance: 4 },
    ]);
    assert.ok(kept, "the candidate must pass");
    assert.ok(!/^В жизни пользователя/iu.test(kept.content), `the prefix must be cut, got: ${kept.content}`);
    assert.equal(kept.importance, 4);
  });

  it("a type that is no longer allowed is still rejected, importance or not", () => {
    for (const memory_type of ["insight", "theme", "emotion", "tension"]) {
      const filtered = filterCrossMemoryCandidates([{ memory_type, content: "У пользователя есть сын 18 лет", importance: 4 }]);
      assert.equal(filtered.length, 0, `${memory_type} must not pass`);
    }
  });

  it("every other field of the candidate survives as well", () => {
    const [kept] = filterCrossMemoryCandidates([
      { memory_type: "preference", content: "Нужно прямо, без советов", importance: 5, source: "fixture" },
    ]);
    assert.ok(kept, "the candidate must pass");
    assert.equal((kept as { source?: string }).source, "fixture");
    assert.equal(kept.importance, 5);
  });
});

describe("the builder hands over candidates with a valid importance", () => {
  const built = buildCrossMemoryCandidates({
    people: ["сын (18 лет)", "кошка Муся"],
    preferences: ["не нужны пустые успокаивающие фразы, нужно присутствие", "обращаться ко мне в женском роде"],
    important_events: ["сын съехал на съёмную квартиру"],
  });

  it("produces candidates of all three kinds for the fixture", () => {
    assert.ok(built.length >= 4, `expected the fixture to give candidates, got ${built.length}`);
    assert.ok(built.some((c) => c.memory_type === "life_context"));
    assert.ok(built.some((c) => c.memory_type === "communication"));
  });

  it("every candidate has an integer importance from 1 to 5", () => {
    for (const c of built) {
      assert.ok(
        Number.isInteger(c.importance) && c.importance >= 1 && c.importance <= 5,
        `importance of "${c.content}" is ${String(c.importance)}`,
      );
    }
  });

  it("a fact about a person is 4, a way of talking or a preference is 5", () => {
    for (const c of built) {
      const expected = c.memory_type === "life_context" ? 4 : 5;
      assert.equal(c.importance, expected, `"${c.content}" (${c.memory_type})`);
    }
  });
});

describe("what is written when the importance is missing or wrong", () => {
  it("the table is the contract: a way of talking and a preference 5, a fact about a person 4, nothing else", () => {
    assert.deepEqual(CROSS_MEMORY_TYPE_IMPORTANCE, { communication: 5, preference: 5, life_context: 4 });
  });

  it("a whole number from 1 to 5 is kept as it is", () => {
    for (const importance of [1, 2, 3, 4, 5]) {
      assert.equal(resolveCandidateImportance({ memory_type: "life_context", importance }), importance);
    }
  });

  it("an empty or wrong value becomes the importance of the type, not the column default", () => {
    for (const bad of [undefined, null, 0, 6, -1, 3.5, Number.NaN, Number.POSITIVE_INFINITY, "4", {}, []]) {
      assert.equal(resolveCandidateImportance({ memory_type: "life_context", importance: bad }), 4, `life_context with ${String(bad)}`);
      assert.equal(resolveCandidateImportance({ memory_type: "preference", importance: bad }), 5, `preference with ${String(bad)}`);
      assert.equal(resolveCandidateImportance({ memory_type: "communication", importance: bad }), 5, `communication with ${String(bad)}`);
    }
  });

  it("a candidate without the field is judged by its type", () => {
    assert.equal(resolveCandidateImportance({ memory_type: "life_context" }), 4);
  });
});
