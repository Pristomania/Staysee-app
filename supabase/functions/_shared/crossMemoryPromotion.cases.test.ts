/**
 * Run: npx tsx supabase/functions/_shared/crossMemoryPromotion.cases.test.ts
 */

import {
  classifyCrossMemoryCategory,
  evaluateExplicitRememberForCrossMemory,
  isPromotableToCrossMemory,
} from "./crossMemoryPolicy.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function expectBlocked(content: string, label: string): void {
  assert(
    !isPromotableToCrossMemory("life_context", content) &&
      !isPromotableToCrossMemory("communication", content) &&
      !isPromotableToCrossMemory("preference", content),
    `BLOCKED: ${label}`
  );
  console.log(`PASS: ${label} → BLOCKED`);
}

function expectAllowed(
  content: string,
  expectedType: "life_context" | "communication" | "preference",
  label: string
): void {
  const cat = classifyCrossMemoryCategory(content);
  assert(cat !== null, `${label}: no category for ${content}`);
  assert(
    isPromotableToCrossMemory(expectedType, content),
    `${label}: expected ${expectedType}, got category ${cat}`
  );
  console.log(`PASS: ${label} → ALLOWED ${expectedType}`);
}

console.log("=== cross-memory promotion ===\n");

expectBlocked(
  "Пользователь купила курс, но считает, что у преподавателя недостаточно компетенций",
  "past course story"
);
expectAllowed("У пользователя есть сын", "life_context", "stable son short");
expectAllowed("У пользователя есть сын 18 лет", "life_context", "stable son detailed");
expectAllowed("У пользователя есть собака Крис", "life_context", "pet");
expectAllowed(
  "Мне не нужны пустые слова — нужно присутствие",
  "communication",
  "communication preference"
);
expectAllowed(
  "Обращаться ко мне в женском роде",
  "communication",
  "feminine address"
);
expectBlocked(
  "Сегодня пользователь выбирает красный для яркости",
  "temporary clothing"
);
expectBlocked(
  "Племянница с дипломом психолога создала пару с сыном пользователя",
  "family conflict plot"
);
expectAllowed(
  "Пользователь работает над приложением StaySee",
  "life_context",
  "stable project identity"
);
expectBlocked(
  "Пользователь сомневается, можно ли продавать продукт",
  "project doubt"
);

console.log("\n=== explicit remember ===\n");

const fem = evaluateExplicitRememberForCrossMemory(
  "запомни, что обращаться ко мне в женском роде"
);
assert(fem.allowed, "explicit feminine address");
console.log("PASS: explicit feminine → ALLOWED");

const noAdvice = evaluateExplicitRememberForCrossMemory(
  "запомни, что я не хочу советов"
);
assert(noAdvice.allowed, "explicit no advice");
console.log("PASS: explicit no advice → ALLOWED");

const depression = evaluateExplicitRememberForCrossMemory(
  "запомни, я была в депрессии в 20 лет"
);
assert(!depression.allowed, "explicit depression blocked");
console.log("PASS: explicit depression → BLOCKED");

const red = evaluateExplicitRememberForCrossMemory(
  "запомни, что я сегодня выбрала красный"
);
assert(!red.allowed, "explicit red blocked");
console.log("PASS: explicit red → BLOCKED");

console.log("\n=== crossMemoryPromotion.cases.test.ts OK ===\n");
