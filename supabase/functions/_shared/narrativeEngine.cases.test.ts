/**
 * Narrative Engine — unit cases.
 * Run: npx tsx supabase/functions/_shared/narrativeEngine.cases.test.ts
 */

import {
  buildNarrativeContext,
  formatNarrativeForPrompt,
  narrativeContextIsEmpty,
  type ConversationSummary,
  type WeeklyReflection,
} from "./narrativeEngine.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertHedged(items: string[]): void {
  for (const item of items) {
    assert(
      /^(?:Возможно|Похоже|Вероятно),/i.test(item),
      `Expected hedged phrasing, got: ${item}`
    );
  }
}

function assertNoDiagnostics(items: string[]): void {
  for (const item of items) {
    assert(
      !/(?:травм|созависим|нарцисс|диагноз)/i.test(item),
      `Diagnostic label leaked: ${item}`
    );
  }
}

// ── Empty input ───────────────────────────────────────────────────────────────

{
  const ctx = buildNarrativeContext({});
  assert(narrativeContextIsEmpty(ctx), "empty input should yield empty context");
  assert(formatNarrativeForPrompt(ctx) === "", "empty context should not format");
  console.log("✓ empty input");
}

// ── Hedging on all fields ─────────────────────────────────────────────────────

{
  const summary: ConversationSummary = {
    people: ["сын"],
    themes: ["сепарация", "одиночество"],
    emotional_state: ["неопределённость в отношениях"],
    important_events: ["сын съехал из дома несколько недель назад"],
    preferences: ["сохранять границы в близости"],
    risks: [],
    open_loops: ["как жить одной после отъезда сына"],
    last_updated: new Date().toISOString(),
  };
  const ctx = buildNarrativeContext({
    summary,
    recentMessages: [
      {
        role: "user",
        content: "Сегодня впервые мужчина ночует у меня дома, но у него отдельная комната.",
      },
    ],
  });

  const all = [
    ...ctx.currentSituation,
    ...ctx.majorChanges,
    ...ctx.recurringPatterns,
    ...ctx.growthSignals,
    ...ctx.paradoxes,
  ];
  assert(all.length > 0, "fixture should produce narrative items");
  assertHedged(all);
  assertNoDiagnostics(all);
  assert(
    ctx.majorChanges.some((x) => /съехал|сдвиг|впервые/i.test(x)),
    "majorChanges should capture transition"
  );
  assert(
    ctx.growthSignals.some((x) => /границ|отдельн/i.test(x)),
    "growthSignals should capture boundaries"
  );
  assert(ctx.paradoxes.length > 0, "paradoxes should detect opposing movement");
  console.log("✓ hedging + extraction");
}

// ── Weekly diff → majorChanges ────────────────────────────────────────────────

{
  const weekly: WeeklyReflection[] = [
    {
      content:
        "Дом опустел после отъезда сына. Впервые много тишины. Остаётся живым: страх одиночества.",
    },
    {
      content:
        "Неделя была про семью и сына. Много переживаний про сепарацию, но дом ещё был полный голосов.",
    },
  ];
  const ctx = buildNarrativeContext({ weekly });
  assert(
    ctx.majorChanges.some((x) => /опустел|тишин/i.test(x)),
    "weekly diff should surface major change"
  );
  assert(
    ctx.recurringPatterns.some((x) => /одиноч|страх|живым/i.test(x)),
    "weekly should feed recurring patterns"
  );
  console.log("✓ weekly dynamics");
}

// ── Prompt block structure ────────────────────────────────────────────────────

{
  const block = formatNarrativeForPrompt({
    currentSituation: ["Похоже, сейчас дом тише."],
    majorChanges: ["Возможно, после отъезда сына начался новый этап."],
    recurringPatterns: ["Похоже, возвращается тема: одиночество."],
    growthSignals: ["Похоже, признак движения в её словах: сохраняет границы."],
    paradoxes: ["Возможно, в жизни одновременно может ощущаться движение к близости и дистанции."],
  });
  assert(block.includes("ИСТОРИЯ И ДВИЖЕНИЕ ЖИЗНИ:"), "title");
  assert(block.includes("Текущая ситуация:"), "current section");
  assert(block.includes("Изменения:"), "changes section");
  assert(block.includes("Повторяющиеся темы:"), "patterns section");
  assert(block.includes("Признаки роста:"), "growth section");
  assert(block.includes("Парадоксы:"), "paradoxes section");
  assert(block.includes("ДВИЖЕНИЕ ЖИЗНИ (поведение):"), "behavior rules");
  assert(block.includes("не только на последнее сообщение"), "narrative rule");
  console.log("✓ prompt formatting");
}

// ── «Сокровенное» — illustrative fixture ─────────────────────────────────────

const sokrovennoeSummary: ConversationSummary = {
  people: ["сын (18 лет)", "племянница", "мужчина"],
  themes: [
    "семейные отношения",
    "сепарация",
    "одиночество",
    "близость",
    "страх",
    "границы",
  ],
  emotional_state: [
    "неопределённость в отношениях",
    "осторожная надежда",
    "усталость от семейных перестановок",
  ],
  important_events: [
    "сын и племянница съехали на съёмную квартиру",
    "дом стал пустым — пользователь впервые живёт одна",
    "в доме появился мужчина, ночует, но в отдельной комнате",
  ],
  preferences: [
    "искренность без пустых успокаивающих фраз",
    "сохранять свои границы, не сливаясь",
  ],
  risks: [],
  open_loops: [
    "как быть с близостью, не теряя себя",
    "страх одиночества после сепарации сына",
  ],
  last_updated: new Date().toISOString(),
};

const sokrovennoeWeekly: WeeklyReflection[] = [
  {
    content:
      "Несколько недель назад дом опустел после отъезда сына. Возвращались к одиночеству и тишине. Остаётся живым: страх остаться одной и желание близости.",
    created_at: "2026-06-08T12:00:00.000Z",
  },
  {
    content:
      "Неделя про сепарацию и семью: много слов про сына, переезд, пустой дом. Похоже, начинается новый этап — жить без прежней семейной сцены.",
    created_at: "2026-06-01T12:00:00.000Z",
  },
];

const sokrovennoeCrossMemory = [
  {
    memory_type: "life_context",
    content: "сын и племянница троюродные брат и сестра.",
  },
  {
    memory_type: "communication",
    content: "не нужны пустые слова — нужно присутствие.",
  },
];

const sokrovennoeMessages = [
  {
    role: "user" as const,
    content: "Несколько недель как сын съехал, и дом совсем другой стал.",
  },
  {
    role: "assistant" as const,
    content: "Тишина после отъезда — это тоже перемена.",
  },
  {
    role: "user" as const,
    content:
      "Сегодня впервые мужчина ночует у меня дома. Я дала ему отдельную комнату — хочу не потерять себя.",
  },
];

const sokrovennoeCtx = buildNarrativeContext({
  summary: sokrovennoeSummary,
  weekly: sokrovennoeWeekly,
  crossMemory: sokrovennoeCrossMemory,
  recentMessages: sokrovennoeMessages,
});

console.log("\n── Пример NarrativeContext для «Сокровенное» ──\n");
console.log(JSON.stringify(sokrovennoeCtx, null, 2));
console.log("\n── Prompt block (фрагмент) ──\n");
console.log(formatNarrativeForPrompt(sokrovennoeCtx));

assert(!narrativeContextIsEmpty(sokrovennoeCtx), "Сокровенное fixture should be rich");
assert(
  sokrovennoeCtx.currentSituation.some((x) => /мужчин|ночует|сегодня/i.test(x)),
  "current situation should reflect latest turn"
);
assert(
  sokrovennoeCtx.majorChanges.some((x) => /сын|опустел|пуст|съех/i.test(x)),
  "major changes should include son leaving / empty home"
);
assert(
  sokrovennoeCtx.recurringPatterns.some((x) => /одиноч|сепарац|близост/i.test(x)),
  "recurring patterns from themes"
);
assert(
  sokrovennoeCtx.growthSignals.some((x) => /границ|отдельн/i.test(x)),
  "growth signals from boundaries"
);
assert(sokrovennoeCtx.paradoxes.length > 0, "paradoxes for closeness vs solitude");
console.log("\n✓ Сокровенное fixture");

console.log("\nAll narrativeEngine cases passed.");
