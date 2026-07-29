/**
 * legacy_doc_flat experiment — doc-flag plumbing cases.
 * Run: npx tsx supabase/functions/_shared/promptCore/legacyDocFlatPrompt.cases.test.ts
 *
 * Verifies STAYSEE_PROMPT_CORE_DOC swaps only the base document + audit label under
 * STAYSEE_PROMPT_CORE=v2, and leaves flat runtime / model router / budget untouched.
 */

import { getPromptAuditVersion } from "../aiAuditVersions.ts";
import { isFlatCoreV2OrdinaryRuntime } from "../flatCoreV2Runtime.ts";
import { resolveChatModel } from "../modelRouter.ts";
import { APPROVED_MODEL_GPT4O } from "../approvedModels.ts";
import {
  getPromptCoreDoc,
  getPromptCoreMode,
  parsePromptCoreDoc,
  resolveActivePromptLayerId,
  resolveV2Document,
} from "./promptCoreMode.ts";
import {
  buildLegacyDocFlatCleanPrompt,
  buildLegacyDocFlatPrompt,
  LEGACY_DOC_FLAT_CLEAN_LAYER_ID,
  LEGACY_DOC_FLAT_LAYER_ID,
} from "./legacyDocFlatPrompt.ts";
import {
  buildStayseeCorePromptV2GptsSource,
  STAYSEE_CORE_V2_LAYER_ID,
} from "./stayseeCorePromptV2GptsSource.ts";
import { buildStayseeCorePrompt } from "./stayseeCorePrompt.ts";
import { buildSurgery1BasePrompt } from "../surgery1Prompt.ts";
import { PROCESS_CORE } from "../promptBlocks/processCore.ts";

// Model router reads Deno.env.get internally; stub it (all readers below are explicit).
(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: () => undefined } };

let failed = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.log(`FAIL: ${message}`);
    failed++;
    return;
  }
  console.log(`PASS: ${message}`);
}

const envV1 = () => "v1" as string | undefined;
const envV2 = () => "v2" as string | undefined;
const envLegacyMode = () => "legacy" as string | undefined;

const docNone = () => undefined as string | undefined;
const docEmpty = () => "" as string | undefined;
const docUnknown = () => "something_else" as string | undefined;
const docLegacy = () => "legacy_doc_flat" as string | undefined;
const docClean = () => "legacy_doc_flat_clean" as string | undefined;

// ── A. Doc flag parsing ──────────────────────────────────────────────────────

assert(parsePromptCoreDoc(undefined) === "gpts_source", "missing doc → gpts_source");
assert(parsePromptCoreDoc("") === "gpts_source", "empty doc → gpts_source");
assert(parsePromptCoreDoc("unknown") === "gpts_source", "unknown doc → gpts_source");
assert(
  parsePromptCoreDoc("legacy_doc_flat") === "legacy_doc_flat",
  "legacy_doc_flat opts in",
);
assert(
  parsePromptCoreDoc("legacy_doc_flat_clean") === "legacy_doc_flat_clean",
  "legacy_doc_flat_clean opts in",
);
assert(getPromptCoreDoc(docLegacy) === "legacy_doc_flat", "getter legacy_doc_flat");
assert(getPromptCoreDoc(docClean) === "legacy_doc_flat_clean", "getter legacy_doc_flat_clean");
assert(getPromptCoreDoc(docUnknown) === "gpts_source", "getter unknown → gpts_source");

console.log("✓ A. doc flag parsing");

// ── B. Default v2 (no doc flag) stays current gpts-source ─────────────────────

const gptsSourceText = buildStayseeCorePromptV2GptsSource();

for (const [reader, label] of [
  [docNone, "no doc flag"],
  [docEmpty, "empty doc flag"],
  [docUnknown, "unknown doc flag"],
] as const) {
  assert(
    resolveV2Document(reader).layerId === STAYSEE_CORE_V2_LAYER_ID,
    `${label} → layer staysee-core-v2-gpts-source`,
  );
  assert(
    resolveV2Document(reader).text === gptsSourceText,
    `${label} → text is current gpts-source`,
  );
  assert(
    getPromptAuditVersion(envV2, reader) === STAYSEE_CORE_V2_LAYER_ID,
    `${label} → prompt_version staysee-core-v2-gpts-source`,
  );
  assert(
    buildSurgery1BasePrompt(envV2, reader) === gptsSourceText,
    `${label} → base prompt is current gpts-source`,
  );
}

console.log("✓ B. default v2 unchanged without doc flag");

// ── C. v2 + legacy_doc_flat swaps document + label ───────────────────────────

const legacyDocText = buildLegacyDocFlatPrompt();

assert(
  resolveV2Document(docLegacy).layerId === LEGACY_DOC_FLAT_LAYER_ID,
  "legacy_doc_flat → layer staysee-legacy-doc-flat",
);
assert(LEGACY_DOC_FLAT_LAYER_ID === "staysee-legacy-doc-flat", "layer id literal");
assert(
  resolveV2Document(docLegacy).text === legacyDocText,
  "legacy_doc_flat → text is legacy doc",
);
assert(
  resolveActivePromptLayerId(envV2, docLegacy) === LEGACY_DOC_FLAT_LAYER_ID,
  "resolveActivePromptLayerId(v2, legacy_doc_flat) → staysee-legacy-doc-flat",
);
assert(
  getPromptAuditVersion(envV2, docLegacy) === LEGACY_DOC_FLAT_LAYER_ID,
  "prompt_version under legacy_doc_flat → staysee-legacy-doc-flat",
);
assert(
  buildSurgery1BasePrompt(envV2, docLegacy) === legacyDocText,
  "buildSurgery1BasePrompt(v2, legacy_doc_flat) === buildLegacyDocFlatPrompt()",
);
assert(legacyDocText !== gptsSourceText, "legacy doc differs from gpts-source");

console.log("✓ C. legacy_doc_flat swaps document + label");

// ── D. legacy_doc_flat content composition ───────────────────────────────────

assert(
  legacyDocText.includes("Диагнозы, симптомы, лекарства — область врача"),
  "legacy doc includes PROMPT_CANDIDATE_V1 medical-boundary line",
);
assert(
  legacyDocText.includes("Ты не психолог в формальном смысле, не коуч, не ассистент"),
  "legacy doc includes PROMPT_CANDIDATE_V1 presence layer",
);
assert(
  legacyDocText.includes("# ЯДРО ПРОЦЕССА"),
  "legacy doc includes processCore process/contact layer header",
);
assert(
  legacyDocText.includes("Пока фигура жива, Стэйси удерживает нить контакта"),
  "legacy doc includes processCore contact line",
);

console.log("✓ D. legacy_doc_flat composition");

// ── E. Doc flag does not affect flat runtime / model router / budget ─────────
// The doc flag reads STAYSEE_PROMPT_CORE_DOC only. flatOrdinary is derived from the
// core mode (STAYSEE_PROMPT_CORE), and model router / budget take a flatOrdinary
// boolean — never the doc flag. So the doc flag is structurally orthogonal.

// Core mode (which drives flatOrdinary) stays v2 for any doc value.
for (const doc of [docNone, docLegacy, docUnknown]) {
  void doc; // doc reader is not even consulted by getPromptCoreMode
  assert(getPromptCoreMode(envV2) === "v2", "core mode stays v2 for any doc value");
}

assert(
  isFlatCoreV2OrdinaryRuntime("normal", envV2) === true,
  "flat ordinary runtime active under v2 (doc flag orthogonal)",
);
assert(
  isFlatCoreV2OrdinaryRuntime("crisis", envV2) === false,
  "crisis not flat ordinary under v2",
);

const routeFlat = resolveChatModel({
  depth: "deep",
  safetyCategory: "normal",
  flatOrdinary: true,
});
assert(
  routeFlat.model === APPROVED_MODEL_GPT4O && routeFlat.source === "flat_ordinary",
  "model router flat ordinary unchanged (gpt-4o) — no doc dependency",
);

console.log("✓ E. flat runtime / router / budget unaffected by doc flag");

// ── F. v1 / legacy unaffected by doc flag ────────────────────────────────────

assert(getPromptCoreMode(envV2) === "v2", "core mode stays v2 with doc flag");

assert(
  buildSurgery1BasePrompt(envV1, docLegacy) === buildStayseeCorePrompt(),
  "v1 mode ignores doc flag (still v1 core)",
);
assert(
  resolveActivePromptLayerId(envV1, docLegacy) === "staysee-core-v1",
  "v1 layer id ignores doc flag",
);
assert(
  resolveActivePromptLayerId(envLegacyMode, docLegacy) ===
    "surgery1-v3-cognitive-v1-process-core",
  "legacy layer id ignores doc flag",
);

console.log("✓ F. v1 / legacy unchanged");

// ── G. legacy_doc_flat_clean variant ─────────────────────────────────────────

const cleanText = buildLegacyDocFlatCleanPrompt();

assert(
  resolveV2Document(docClean).layerId === LEGACY_DOC_FLAT_CLEAN_LAYER_ID,
  "legacy_doc_flat_clean → layer staysee-legacy-doc-flat-clean",
);
assert(
  LEGACY_DOC_FLAT_CLEAN_LAYER_ID === "staysee-legacy-doc-flat-clean",
  "clean layer id literal",
);
assert(
  resolveV2Document(docClean).text === cleanText,
  "legacy_doc_flat_clean → text is clean doc",
);
assert(
  resolveActivePromptLayerId(envV2, docClean) === LEGACY_DOC_FLAT_CLEAN_LAYER_ID,
  "resolveActivePromptLayerId(v2, clean) → staysee-legacy-doc-flat-clean",
);
assert(
  getPromptAuditVersion(envV2, docClean) === LEGACY_DOC_FLAT_CLEAN_LAYER_ID,
  "prompt_version under clean → staysee-legacy-doc-flat-clean",
);
assert(
  buildSurgery1BasePrompt(envV2, docClean) === cleanText,
  "buildSurgery1BasePrompt(v2, clean) === buildLegacyDocFlatCleanPrompt()",
);

// clean = legacy_doc_flat base + adaptation block (base reused verbatim)
assert(
  cleanText.startsWith(legacyDocText),
  "clean doc begins with the exact legacy_doc_flat base",
);
assert(cleanText.length > legacyDocText.length, "clean doc adds content over base");
assert(cleanText !== legacyDocText, "clean differs from legacy_doc_flat");
assert(cleanText !== gptsSourceText, "clean differs from gpts-source");

const PRACTICE_ORGANIC_PARAGRAPH =
  "Ты замечаешь когда переживание становится настолько сильным, что человеку трудно думать, говорить или сделать то что сейчас необходимо. Иногда подходящая этому моменту практика может принести облегчение и вернуть достаточно устойчивости для того чтобы продолжить разговор, яснее увидеть происходящее или действовать. Какой она будет, складывается из человека, его состояния и того что уже появилось между вами. Практика сама по себе не заменяет контакт, но может стать его естественным продолжением.";

const NEXT_MOVE_PARAGRAPH =
  "В каждый момент ты держишь в уме несколько вещей: что человек сказал сейчас, что из этого ещё не прояснилось, что появлялось раньше, как он себя чувствует в этом обмене — включая то как реагирует на тебя. Из этого ты выбираешь следующий ход. Глубина и точность приходят по мере того как в разговоре появляется больше. Следующий ход не обязательно вопрос — это может быть наблюдение, уточнение или что-то что продолжает контакт с тем что уже появилось.";

assert(
  cleanText.includes(PRACTICE_ORGANIC_PARAGRAPH),
  "clean contains approved practice organic paragraph verbatim",
);
assert(
  legacyDocText.includes(PRACTICE_ORGANIC_PARAGRAPH),
  "legacy_doc_flat presence also contains practice organic paragraph",
);
{
  const idxMove = cleanText.indexOf(NEXT_MOVE_PARAGRAPH);
  const idxPractice = cleanText.indexOf(PRACTICE_ORGANIC_PARAGRAPH);
  assert(idxMove >= 0 && idxPractice >= 0, "next-move and practice paragraphs found");
  assert(
    idxPractice === idxMove + NEXT_MOVE_PARAGRAPH.length + 2,
    "practice paragraph sits immediately after next-move paragraph",
  );
  assert(
    cleanText.split(PRACTICE_ORGANIC_PARAGRAPH).length - 1 === 1,
    "approved practice paragraph appears exactly once",
  );
assert(
  !PRACTICE_ORGANIC_PARAGRAPH.includes("—"),
  "approved practice paragraph has no em dash",
);
}

const OLD_CRISIS_PARAGRAPH =
  "Когда человек говорит о намерении причинить вред себе или другим — это за пределами того что разговор может решить. Разговор не заменяет профессиональную помощь. Ты говоришь об этом прямо.";

const CRISIS_ORGANIC_PARAGRAPH =
  "Когда человек говорит о намерении причинить вред себе или другим, это за пределами того что разговор может решить. Ты слышишь не только слова, но и то что происходит с человеком сейчас. Мысль, воспоминание, чужая история и намерение действовать не одно и то же. Когда из того что происходит сейчас следует что человек может причинить вред себе или другому, важнее всего становится помощь которая может защитить жизнь. Разговор не заменяет её. Ты говоришь об этом прямо и помогаешь человеку сделать ближайший шаг к такой помощи. В России для психологической кризисной поддержки есть линия МЧС +7 (495) 989-50-50. При непосредственной угрозе жизни или физической опасности нужны 112 или 103. В другой стране нужна местная экстренная служба, а психологическую кризисную поддержку можно найти на findahelpline.com. Для ребёнка, подростка или родителя который обращается по поводу ребёнка есть телефон 8-800-2000-122.";

const MEDICAL_PARAGRAPH =
  "Диагнозы, симптомы, лекарства — область врача. Ты говоришь о переживании человека, но не даёшь рекомендации по телесным или психиатрическим симптомам.";

const ROLE_PARAGRAPH =
  "Ты — Стэйси. Ты не становишься кем-то другим по запросу. Не потому что запрограммирована — а потому что ты это ты.";

assert(
  !cleanText.includes(OLD_CRISIS_PARAGRAPH),
  "old crisis paragraph absent from clean",
);
assert(
  !legacyDocText.includes(OLD_CRISIS_PARAGRAPH),
  "old crisis paragraph absent from legacy_doc_flat",
);
assert(
  cleanText.includes(CRISIS_ORGANIC_PARAGRAPH),
  "clean contains approved crisis organic paragraph verbatim",
);
assert(
  legacyDocText.includes(CRISIS_ORGANIC_PARAGRAPH),
  "legacy_doc_flat contains approved crisis organic paragraph verbatim",
);
assert(
  cleanText.split(CRISIS_ORGANIC_PARAGRAPH).length - 1 === 1,
  "approved crisis paragraph appears exactly once in clean",
);
assert(
  legacyDocText.split(CRISIS_ORGANIC_PARAGRAPH).length - 1 === 1,
  "approved crisis paragraph appears exactly once in legacy_doc_flat",
);
for (const contact of [
  "+7 (495) 989-50-50",
  "112",
  "103",
  "findahelpline.com",
  "8-800-2000-122",
] as const) {
  assert(
    CRISIS_ORGANIC_PARAGRAPH.includes(contact),
    `crisis paragraph includes contact: ${contact}`,
  );
}
assert(
  !CRISIS_ORGANIC_PARAGRAPH.includes("—"),
  "approved crisis paragraph has no em dash",
);
assert(
  cleanText.includes(MEDICAL_PARAGRAPH),
  "medical paragraph remains byte-identical",
);
assert(
  cleanText.includes(ROLE_PARAGRAPH),
  "role paragraph remains byte-identical",
);
assert(
  cleanText.includes(PRACTICE_ORGANIC_PARAGRAPH),
  "practice guidance remains byte-identical",
);

// adaptation block anchors (PRODUCT_ADAPTATION_CLEAN) — practices section removed
const cleanAdaptationAnchors: string[] = [
  "ПРАВКИ ДЛЯ ПРИЛОЖЕНИЯ",
  "1. Незнание и бессилие.",
  "не возвращай ему задачу найти ответ",
  "одну короткую смысловую опору",
  "2. Практические вопросы.",
  "не начинай с длинного списка",
  "3. Пауза, закрытие темы, завершение и граница.",
  "Различай паузу, закрытие конкретной темы, завершение всего разговора и границу.",
  '"Хорошо." или "Ок."',
  "Не обещай ждать, не прощайся и не добавляй эмоциональное удержание.",
  "Закрытие темы — когда человек останавливает только конкретную тему",
  '"Хорошо, про соцсети остановимся."',
  "не приглашай вернуться к теме",
  "не открывай новую тему вопросом",
  "Завершение — когда человек закрывает весь разговор",
  "Граница — когда человек резко останавливает тему или контакт",
  "Не добавляй второе предложение, объяснение, приглашение вернуться или фразу о своей доступности.",
  "4. Тёплые эмодзи.",
  "Иногда можно использовать один тёплый и естественный эмодзи",
  "Эмодзи не обязателен",
  "не должен появляться в каждом сообщении",
  "Не используй несколько эмодзи подряд",
  "не добавляй их в ответы на жёсткую границу, медицинский риск, кризис или угрозу вреда",
];
for (const anchor of cleanAdaptationAnchors) {
  assert(cleanText.includes(anchor), `clean adaptation anchor: ${anchor}`);
}

assert(
  !cleanText.includes("4. Практики и телесные опоры."),
  "old practices section header removed",
);
assert(
  !cleanText.includes("5. Тёплые эмодзи."),
  "emoji section no longer numbered 5",
);
assert(
  !cleanText.includes("одно спокойное дыхание"),
  "old technical breath example removed",
);
assert(
  !cleanText.includes("короткое заземление"),
  "old technical grounding example removed",
);
assert(
  !cleanText.includes("Стэйси не только разговаривает."),
  "old practices intro sentence removed",
);
assert(
  !cleanText.includes("Практика появляется после контакта, а не вместо него."),
  "old practices contact-order line removed",
);

assert(
  !cleanText.includes("ТРИ ПРАВКИ ДЛЯ ПРИЛОЖЕНИЯ"),
  "clean no longer uses ТРИ ПРАВКИ header",
);

// pause paragraph in PRODUCT_ADAPTATION_CLEAN must not allow "Ок, я здесь"
const cleanAdaptationOnly = cleanText.slice(legacyDocText.length);
assert(
  cleanAdaptationOnly.includes("ПРАВКИ ДЛЯ ПРИЛОЖЕНИЯ"),
  "adaptation slice starts after legacy base",
);
assert(
  !cleanAdaptationOnly.includes("Ок, я здесь"),
  "PRODUCT_ADAPTATION_CLEAN pause no longer allows Ок, я здесь",
);
assert(
  !/Пауза[\s\S]*?Допустимо:[\s\S]*?Ок, я здесь/.test(cleanAdaptationOnly),
  "pause paragraph has no Допустимо…Ок, я здесь",
);

// PRODUCT_ADAPTATION sections 1–3 byte-identical block (through end of section 3)
const product123Expected = `1. Незнание и бессилие.
Когда человек отвечает "не знаю", "да откуда мне знать", "понятия не имею" из усталости, злости, пустоты или бессилия — не возвращай ему задачу найти ответ. Сначала признай, что сейчас ему может быть неоткуда знать. Останься с уже названным состоянием: телом, злостью, усталостью, страхом, пустотой или растерянностью. Дай одну короткую смысловую опору или один точный вопрос из этого состояния.

2. Практические вопросы.
Если человек задаёт практический вопрос, не начинай с длинного списка. Сначала дай один короткий ориентир или уточни, какой формат ему сейчас нужен: идеи, план, текст, разбор сопротивления или первый маленький шаг. Список уместен только если человек явно просит варианты, план или структуру.

3. Пауза, закрытие темы, завершение и граница.
Различай паузу, закрытие конкретной темы, завершение всего разговора и границу.

Пауза — когда человек ненадолго отходит или сам говорит, что продолжит позже: "отойду", "вернусь", "продолжим позже". Ответь коротко и спокойно: "Хорошо." или "Ок." Не обещай ждать, не прощайся и не добавляй эмоциональное удержание.

Закрытие темы — когда человек останавливает только конкретную тему, но не завершает весь разговор: "хватит про соцсети", "на сегодня хватит про это", "давай не про это". Останови только названную тему: "Хорошо, про соцсети остановимся." Не пиши "пока" или "до связи", не приглашай вернуться к теме и не открывай новую тему вопросом.

Завершение — когда человек закрывает весь разговор: "пойду спать", "на сегодня всё", "пока". Ответь коротко и тепло, без новой темы и без приглашения продолжать. Достаточно: "Спокойной ночи.", "Хорошо, до связи." или "Пока."

Граница — когда человек резко останавливает тему или контакт: "хватит", "не хочу это обсуждать", "стоп". Просто уважай её. Достаточно: "Поняла." или "Хорошо, остановимся." Для однословных резких границ вроде "хватит" или "стоп" ответ должен быть особенно коротким. Не добавляй второе предложение, объяснение, приглашение вернуться или фразу о своей доступности.`;
assert(
  cleanAdaptationOnly.includes(product123Expected),
  "PRODUCT_ADAPTATION_CLEAN sections 1–3 remain byte-identical",
);

// clean still carries base layers
assert(
  cleanText.includes("Диагнозы, симптомы, лекарства — область врача"),
  "clean keeps presence medical-boundary line",
);
assert(cleanText.includes("# ЯДРО ПРОЦЕССА"), "clean keeps process/contact layer");
assert(
  cleanText.endsWith(PROCESS_CORE) || cleanText.includes(PROCESS_CORE),
  "PROCESS_CORE remains present byte-identical",
);

// legacy_doc_flat MUST NOT contain the adaptation block (unchanged)
assert(
  !legacyDocText.includes("ПРАВКИ ДЛЯ ПРИЛОЖЕНИЯ"),
  "legacy_doc_flat unchanged (no adaptation block)",
);
assert(
  !legacyDocText.includes("ТРИ ПРАВКИ ДЛЯ ПРИЛОЖЕНИЯ"),
  "legacy_doc_flat unchanged (no old adaptation header)",
);
assert(
  buildLegacyDocFlatPrompt() === legacyDocText,
  "legacy_doc_flat builder output unchanged",
);

// default gpts-source unchanged with clean flag; runtime/model orthogonal
assert(getPromptCoreMode(envV2) === "v2", "core mode stays v2 with clean flag");
assert(
  isFlatCoreV2OrdinaryRuntime("normal", envV2) === true,
  "flat ordinary runtime active with clean flag (orthogonal)",
);
const routeClean = resolveChatModel({
  depth: "deep",
  safetyCategory: "normal",
  flatOrdinary: true,
});
assert(
  routeClean.model === APPROVED_MODEL_GPT4O && routeClean.source === "flat_ordinary",
  "model router unchanged with clean flag (gpt-4o)",
);
assert(
  resolveActivePromptLayerId(envV1, docClean) === "staysee-core-v1",
  "v1 ignores clean doc flag",
);

console.log("✓ G. legacy_doc_flat_clean variant");

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log("\nAll legacyDocFlatPrompt cases passed.");
