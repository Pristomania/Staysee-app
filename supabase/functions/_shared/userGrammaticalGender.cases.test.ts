/**
 * User grammatical gender detector — unit cases.
 * Run: npx tsx supabase/functions/_shared/userGrammaticalGender.cases.test.ts
 */

import { SURGERY1_BLOCKS } from "./surgery1Prompt.ts";
import {
  detectUserGrammaticalGender,
  parseGenderFromMemoryTexts,
} from "./userGrammaticalGender.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function msgs(...userLines: string[]) {
  return userLines.map((content) => ({ role: "user", content }));
}

function runDetectorCase(
  name: string,
  input: Parameters<typeof detectUserGrammaticalGender>[0],
  exp: { gender: string; confidence: string; source: string }
) {
  const r = detectUserGrammaticalGender(input);
  assert(
    r.gender === exp.gender && r.confidence === exp.confidence && r.source === exp.source,
    `${name}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(r)}`
  );
  console.log(`PASS detector: ${name}`);
}

console.log("=== userGrammaticalGender.cases ===\n");

runDetectorCase(
  "feminine two hits",
  { messages: msgs("Я устала", "Я не поняла, что со мной") },
  { gender: "feminine", confidence: "high", source: "detector" }
);

runDetectorCase(
  "masculine two hits",
  { messages: msgs("Я устал", "Я не понял, что со мной") },
  { gender: "masculine", confidence: "high", source: "detector" }
);

runDetectorCase(
  "unknown vague",
  { messages: msgs("Мне плохо", "Не знаю, что делать") },
  { gender: "unknown", confidence: "low", source: "unknown" }
);

runDetectorCase(
  "mixed feminine/masculine",
  {
    messages: msgs("Я устала", "Я устал"),
  },
  { gender: "unknown", confidence: "low", source: "unknown" }
);

runDetectorCase(
  "third person quote ignored",
  { messages: msgs("Он сказал, что устал", "Мне тяжело") },
  { gender: "unknown", confidence: "low", source: "unknown" }
);

runDetectorCase(
  "memory preference feminine",
  {
    messages: msgs("Мне плохо"),
    conversationPreferences: ["Обращаться в женском роде."],
  },
  { gender: "feminine", confidence: "high", source: "memory" }
);

runDetectorCase(
  "explicit я мужчина",
  { messages: msgs("Я мужчина, давай поговорим") },
  { gender: "masculine", confidence: "high", source: "detector" }
);

runDetectorCase(
  "memory beats detector",
  {
    messages: msgs("Я устала", "Я не поняла"),
    conversationPreferences: ["Обращаться в мужском роде."],
  },
  { gender: "masculine", confidence: "high", source: "memory" }
);

const neutralMem = parseGenderFromMemoryTexts(["Предпочитает нейтральное обращение"]);
assert(
  neutralMem?.gender === "neutral" && neutralMem.source === "memory",
  "neutral memory parse"
);
console.log("PASS detector: neutral memory parse");

const identity = SURGERY1_BLOCKS.identity;
assert(identity.includes("я готова"), "IDENTITY: я готова");
assert(identity.includes("я поняла"), "IDENTITY: я поняла");
assert(identity.includes("я заметила"), "IDENTITY: я заметила");
assert(identity.includes("«я готов»"), "IDENTITY: ban я готов");
assert(identity.includes("«я понял»"), "IDENTITY: ban я понял");
console.log("PASS identity: StaySee feminine self-reference rule");

console.log("\nAll userGrammaticalGender cases passed.");
