/**
 * Run: npx tsx src/lib/memoryDisplayNormalize.cases.test.ts
 */

import { normalizeMemoryTextForDisplay } from "./memoryDisplayNormalize";

function assertEq(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected "${expected}", got "${actual}"`);
  }
}

assertEq(normalizeMemoryTextForDisplay("племянница пользователя"), "племянница", "niece");
assertEq(normalizeMemoryTextForDisplay("сын пользователя"), "сын", "son");
assertEq(normalizeMemoryTextForDisplay("мама пользователя"), "мама", "mother");

assertEq(
  normalizeMemoryTextForDisplay("У пользователя есть сын (18 лет)."),
  "есть сын (18 лет).",
  "son fact"
);
assertEq(
  normalizeMemoryTextForDisplay("У пользователя есть собака Крис."),
  "есть собака Крис.",
  "pet fact"
);
assertEq(
  normalizeMemoryTextForDisplay("Партнёр не живёт с пользователем вместе."),
  "партнёр не живёт вместе",
  "partner separate"
);

assertEq(
  normalizeMemoryTextForDisplay("Пользователь предпочитает прямоту."),
  "предпочитает прямоту.",
  "pref short"
);
assertEq(
  normalizeMemoryTextForDisplay(
    "Пользователь предпочитает прямоту и не выносит, когда теряют нить разговора."
  ),
  "предпочитает прямоту и не выносит, когда теряют нить разговора.",
  "pref long"
);
assertEq(
  normalizeMemoryTextForDisplay("Пользователю важно разделять темы."),
  "важно разделять темы.",
  "important split topics"
);

const protectedTerm = "это слово пользователь обсуждалось как термин";
assertEq(
  normalizeMemoryTextForDisplay(protectedTerm),
  protectedTerm,
  "protected term unchanged"
);

console.log("memoryDisplayNormalize.cases.test.ts OK");
