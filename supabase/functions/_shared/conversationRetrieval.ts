/**
 * Archive search within ONE conversation only.
 * Never searches other chats or merges conversation summaries.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { estimateTokens } from "./cost.ts";
import type { EmbeddingApiConfig } from "./embeddings.ts";
import {
  ensureConversationEmbeddings,
  searchSemanticConversationArchive,
} from "./messageEmbeddings.ts";
import { normalizeMessageRole } from "./messageRole.ts";

export const RETRIEVAL_MAX_FETCH = 400;
export const RETRIEVAL_TOP_K = 8;
export const RETRIEVAL_TOP_K_RECALL = 12;
export const RETRIEVAL_MAX_EXCERPT_CHARS = 420;
export const RETRIEVAL_MAX_TOTAL_CHARS = 2_800;
/** Keep at least this many older messages searchable (not eaten by tail exclusion) */
const MIN_ARCHIVE_MESSAGES = 10;

const RU_STOP = new Set([
  "это", "как", "что", "ты", "те", "я", "мы", "вы", "он", "она", "они",
  "в", "на", "и", "а", "но", "не", "да", "же", "ли", "бы", "у", "о", "с",
  "к", "по", "для", "мне", "меня", "тебя", "вас", "очень", "просто", "когда",
  "если", "вот", "ещё", "еще", "уже", "тоже", "так", "тут", "там", "где",
  "кто", "чем", "про", "из", "до", "после", "или", "нет", "была", "был",
  "были", "будет", "есть", "быть", "мой", "моя", "мои", "твой", "свой",
  "наш", "ваш", "этот", "эта", "эти", "чтобы", "потому", "может", "можно",
  "надо", "могу", "хочу", "себя", "сам", "сама", "все", "всё", "вся",
]);

const RECALL_INTENT_RE =
  /помнишь|помните|помни|забыла|забыл|говорил[аи]?|говорила|сказал[аи]?|сказала|обсуждал[аи]?|обсуждали|раньше|прошл(ый|ом|ую|ого|ым)|в прошл|прошлом году|прошлым летом|напомни|не помню|ты писал|ты написал|мы говорили|посмотри|говорила тебе|сказала тебе|я говорила|как было|что было|что случилось|тогда|в том числе|ещё раз|еще раз|продолжим|продолжить тему|рассказала|рассказывала|что я говорила|что ты помнишь|у меня этого нет|не доверя|прошлого раза|вчера\s+(?:я\s+)?рассказывала|рассказывала\s+вчера|о\s+себе\s+и|что\s+я\s+рассказывала/i;

/** Topic return without explicit «помнишь» — light archive only. */
const CONTINUITY_INTENT_RE =
  /продолжим|продолжить|вернёмся|вернемся|как вчера|вчера мы|на прошлой неделе|мы обсуждали|снова про|ещё про|еще про|та же тема|о том что|про то что/i;

/** User corrects memory («я ещё писала…», «не только это») — full retrieval. */
const MEMORY_CORRECTION_RE =
  /ещ[её]\s+писал|я\s+(?:уже\s+)?писал|не\s+только\s+это|забыл[аи]?\s+что|ты\s+не\s+то\s+помнишь|а\s+я\s+(?:же\s+)?(?:писала|говорила)|мы\s+поругал/i;

export type ArchiveRetrievalMode = "off" | "light" | "full";

export const RETRIEVAL_TOP_K_LIGHT = 4;
export const RETRIEVAL_MAX_TOTAL_CHARS_LIGHT = 1_400;

export interface ArchiveExcerpt {
  userText: string;
  assistantText: string | null;
  createdAt: string;
  score: number;
}

interface RawExchange {
  userText: string;
  assistantText: string | null;
  createdAt: string;
}

function tokenizeQuery(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !RU_STOP.has(w));
  return [...new Set(raw)].slice(0, 32);
}

export function hasRecallIntent(query: string): boolean {
  return RECALL_INTENT_RE.test(query) || MEMORY_CORRECTION_RE.test(query);
}

/**
 * When to load archive / embeddings / verbatim quotes.
 * Off = rely on ПАМЯТЬ БЕСЕДЫ, сквозную память и хвост реплик (unchanged).
 */
export function resolveArchiveRetrievalMode(query: string): ArchiveRetrievalMode {
  const q = query.trim();
  if (!q) return "off";
  if (hasRecallIntent(q) || CONTINUITY_INTENT_RE.test(q)) return "full";
  const terms = tokenizeQuery(q);
  if (terms.length >= 2) return "light";
  if (terms.length === 1 && terms[0].length >= 5) return "light";
  if (q.length >= 180) return "light";
  return "off";
}

/** «Про ссору» → поругалась, обвинил, манипулировал и т.д. */
export function expandRecallTopicStems(query: string): string[] {
  const stems = topicStemsFromText(query);
  const q = query.toLowerCase();

  if (/ссор|поругал|ругал|поссор|конфликт/i.test(q)) {
    stems.push("поругал", "ругал", "ссор", "обвин", "манипул", "контрол", "улич");
  }

  if (/на\s+связи|связи|связь|проверял|прощуп|вопрос/i.test(q)) {
    stems.push("связ", "провер", "вопрос", "мужчин");
  }

  if (/его\b|мужчин|партн|\bон\b/i.test(q) && !stems.includes("мужчин")) {
    stems.push("мужчин");
  }

  const about = q.match(/\bпро\s+([а-яё]{3,12})/i);
  if (about?.[1]) {
    const topic = about[1];
    if (/^ссор/.test(topic)) {
      stems.push("поругал", "ругал", "ссор", "обвин", "манипул", "контрол", "улич");
    }
    if (/мужчин|партн|^муж/.test(topic)) stems.push("мужчин");
  }

  return [...new Set(stems)];
}

function mergeSearchTerms(query: string, recallIntent: boolean): string[] {
  const terms = tokenizeQuery(query);
  if (!recallIntent) return terms;
  return [...new Set([...terms, ...expandRecallTopicStems(query)])];
}

function topicStemsFromText(text: string): string[] {
  const stems: string[] = [];
  if (/мужчин|\bему\b|\bего\b|\bон\b/i.test(text)) stems.push("мужчин");
  if (/отношен/i.test(text)) stems.push("отношен");
  if (/партн/i.test(text)) stems.push("партн");
  if (/поругал|ссор|ругал|поссор/i.test(text)) {
    stems.push("поругал", "ссор");
  }
  if (/развод/i.test(text)) stems.push("развод");
  if (/не живу|живу одн|прожива|вместе/i.test(text)) stems.push("жив");
  if (/довер/i.test(text)) stems.push("довер");
  if (/прошл|прошлом|прошлым|прошлого|в прошл|год[ауе]?|летом|лете/i.test(text)) {
    stems.push("прошл");
  }
  if (/преда|предатель/i.test(text)) stems.push("пред");
  if (/испугал|беспомощ|отдаля/i.test(text)) stems.push("испуг");
  if (/сын|дочь|дочер|детей|ребён|ребен/i.test(text)) stems.push("сын");
  return [...new Set(stems)];
}

function newestUserMessageAt(
  messages: Array<{ role: "user" | "assistant"; created_at: string }>
): string {
  let best = "";
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (!best || m.created_at > best) best = m.created_at;
  }
  return best;
}

/** Prefer fresh lines when scores are close (old «сын» vs new «поругались»). */
function recencyBoost(createdAt: string, newestAt: string): number {
  if (!newestAt) return 0;
  const t = Date.parse(createdAt);
  const newest = Date.parse(newestAt);
  if (Number.isNaN(t) || Number.isNaN(newest)) return 0;
  const ageMs = Math.max(0, newest - t);
  const day = 86_400_000;
  if (ageMs < day) return 14;
  if (ageMs < 3 * day) return 8;
  if (ageMs < 7 * day) return 3;
  return 0;
}

function queryAsksFightTopic(query: string): boolean {
  return /поругал|ссор|ругал|поссор|не\s+только\s+это|ещ[её]\s+писал/i.test(query);
}

const FIGHT_PRIORITY_STEMS = ["поругал", "ссор", "ругал", "обвин", "манипул", "контрол"];

function scoreQuoteAgainstStems(content: string, stems: string[]): number {
  const lower = content.toLowerCase();
  let score = 0;
  for (const s of stems) {
    if (lower.includes(s)) score += s.length >= 5 ? 3 : 2;
  }
  return score;
}

function scoreQuoteAgainstQuery(
  content: string,
  stems: string[],
  terms: string[]
): number {
  let score = scoreQuoteAgainstStems(content, stems);
  const lower = content.toLowerCase();
  for (const t of terms) {
    if (t.length >= 4 && lower.includes(t)) score += 3;
    else if (t.length >= 3 && lower.includes(t)) score += 1;
  }
  return score;
}

/** Token match when stems miss («на связи», «проверяла»). */
function collectRecallByQueryTokens(
  messages: Array<{ role: "user" | "assistant"; content: string; created_at: string }>,
  query: string,
  cap: number
): UserEvidenceQuote[] {
  const terms = tokenizeQuery(query).filter((t) => t.length >= 3);
  if (terms.length < 1) return [];

  const ranked: Array<UserEvidenceQuote & { score: number }> = [];
  const seen = new Set<string>();

  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = m.content?.trim() ?? "";
    if (text.length < 8) continue;
    const score = scoreQuoteAgainstQuery(text, [], terms);
    if (score <= 0) continue;
    const key = text.slice(0, 64);
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push({ createdAt: m.created_at, text, score });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, cap).map(({ createdAt, text }) => ({ createdAt, text }));
}

function evidenceFromArchiveUserLines(excerpts: ArchiveExcerpt[]): UserEvidenceQuote[] {
  const out: UserEvidenceQuote[] = [];
  const seen = new Set<string>();
  for (const ex of excerpts) {
    const text = ex.userText?.trim() ?? "";
    if (text.length < 8) continue;
    const key = text.slice(0, 64);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ createdAt: ex.createdAt, text });
  }
  return out;
}

export interface UserEvidenceQuote {
  createdAt: string;
  text: string;
}

const FIGHT_ANCHOR_RE = /поругал|ссор|ругал|поссор/i;
const RECALL_THREAD_USER_CAP = 12;
const RECALL_THREAD_MSG_SCAN = 40;

/** After «поругалась» — подтянуть следующие реплики пользователя (детали ссоры). */
function collectRecallThreadQuotes(
  messages: Array<{ role: "user" | "assistant"; content: string; created_at: string }>,
  anchorStems: string[]
): UserEvidenceQuote[] {
  let anchorIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = m.content?.trim() ?? "";
    if (text.length < 8) continue;
    if (
      scoreQuoteAgainstStems(text, anchorStems) > 0 ||
      FIGHT_ANCHOR_RE.test(text)
    ) {
      anchorIdx = i;
    }
  }
  if (anchorIdx < 0) return [];

  const out: UserEvidenceQuote[] = [];
  const seen = new Set<string>();
  let userCount = 0;

  for (
    let i = anchorIdx;
    i < messages.length && userCount < RECALL_THREAD_USER_CAP;
    i++
  ) {
    if (i - anchorIdx > RECALL_THREAD_MSG_SCAN) break;
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = m.content?.trim() ?? "";
    if (text.length < 6) continue;
    const key = text.slice(0, 64);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ createdAt: m.created_at, text });
    userCount++;
  }
  return out;
}

function mergeEvidenceQuotes(
  primary: UserEvidenceQuote[],
  extra: UserEvidenceQuote[],
  cap: number
): UserEvidenceQuote[] {
  const seen = new Set<string>();
  const out: UserEvidenceQuote[] = [];
  for (const q of [...primary, ...extra]) {
    const key = q.text.slice(0, 64);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= cap) break;
  }
  return out;
}

/** Verbatim user lines from this chat — for recall / relationship questions. */
export function collectUserEvidenceQuotes(
  messages: Array<{ role: "user" | "assistant"; content: string; created_at: string }>,
  query: string,
  contextBlob: string
): UserEvidenceQuote[] {
  const recall = hasRecallIntent(query);
  const queryTerms = mergeSearchTerms(query, recall);
  let effectiveStems = expandRecallTopicStems(query);
  if (!effectiveStems.length && recall) {
    effectiveStems = topicStemsFromText(`${query} ${contextBlob}`);
  }
  if (recall && /мужчин|партн|муж\b|его\b/i.test(query) && !effectiveStems.includes("мужчин")) {
    effectiveStems = [...effectiveStems, "мужчин"];
  }
  if (!recall && !effectiveStems.length) return [];

  // Trust / timeline recall often omits «мужчина» in the story message («он предавал…»).
  if (effectiveStems.includes("прошл") || effectiveStems.includes("довер")) {
    if (!effectiveStems.includes("пред")) effectiveStems.push("пред");
    if (!effectiveStems.includes("мужчин")) effectiveStems.push("мужчин");
  }
  effectiveStems = [...new Set(effectiveStems)];

  const ranked: Array<UserEvidenceQuote & { score: number }> = [];
  const seen = new Set<string>();

  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = m.content?.trim() ?? "";
    if (text.length < 8) continue;
    let hitScore = scoreQuoteAgainstQuery(text, effectiveStems, queryTerms);
    if (FIGHT_ANCHOR_RE.test(text) && queryAsksFightTopic(query)) {
      hitScore += 8;
    }
    if (hitScore <= 0) continue;
    const key = text.slice(0, 64);
    if (seen.has(key)) continue;
    seen.add(key);
    const newestAt = newestUserMessageAt(messages);
    ranked.push({
      createdAt: m.created_at,
      text,
      score: hitScore + recencyBoost(m.created_at, newestAt),
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const max = recall ? 16 : 6;
  let quotes = ranked.slice(0, max).map(({ createdAt, text }) => ({ createdAt, text }));

  const fightRecall =
    recall &&
    (queryAsksFightTopic(query) ||
      effectiveStems.some((s) => FIGHT_PRIORITY_STEMS.includes(s)) ||
      FIGHT_ANCHOR_RE.test(query) ||
      FIGHT_ANCHOR_RE.test(contextBlob));

  if (fightRecall) {
    const thread = collectRecallThreadQuotes(messages, FIGHT_PRIORITY_STEMS);
    quotes = mergeEvidenceQuotes(thread, quotes, max);
  }

  if (recall) {
    const byTokens = collectRecallByQueryTokens(messages, query, max);
    quotes = mergeEvidenceQuotes(byTokens, quotes, max);
  }

  if (recall && queryAsksFightTopic(query)) {
    const fightLines = ranked
      .filter((r) => FIGHT_ANCHOR_RE.test(r.text))
      .map(({ createdAt, text }) => ({ createdAt, text }));
    quotes = mergeEvidenceQuotes(fightLines, quotes, max);
  }

  return quotes;
}

export function formatUserEvidenceForPrompt(quotes: UserEvidenceQuote[]): string {
  if (!quotes.length) return "";

  const lines: string[] = [
    "ПОДТВЕРЖДЁННЫЕ СЛОВА ПОЛЬЗОВАТЕЛЯ В ЭТОЙ БЕСЕДЕ (дословно, только этот чат):",
    "Это реальные её сообщения из истории. Если блок не пуст — она УЖЕ говорила об этом здесь.",
    "Запрещено: «ты не говорила», «не помню что было», «у меня этого нет» — если ниже есть цитаты про тот же период/тему.",
    "Запрещено: выдумывать людей и факты, которых нет в цитатах.",
    "Если в чате и сын, и ссора — не сливай в одно: отвечай по теме вопроса; свежие реплики про ссору важнее старых линий.",
    "«Прошлый год / прошлым летом» в её словах = она уже рассказывала; не проси рассказать с нуля, пока не уточнишь пробел.",
    "Можно не помнить каждую деталь, но отрицать весь разговор нельзя.",
    "",
  ];

  for (const q of quotes) {
    const date = formatShortDate(q.createdAt);
    const body = trimExcerpt(q.text, 520);
    lines.push(date ? `- [${date}] «${body}»` : `- «${body}»`);
  }

  return lines.join("\n").trim();
}

function scoreText(text: string, terms: string[]): number {
  if (!terms.length || !text.trim()) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (lower.includes(t)) score += t.length >= 5 ? 4 : 2;
  }
  return score;
}

function trimExcerpt(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function formatShortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "short",
    });
  } catch {
    return "";
  }
}

function exchangeKey(ex: RawExchange): string {
  return `${ex.createdAt}:${ex.userText.slice(0, 40)}`;
}

function extractArchiveExchanges(
  archive: Array<{ role: "user" | "assistant"; content: string; created_at: string }>
): RawExchange[] {
  const out: RawExchange[] = [];
  for (let i = 0; i < archive.length; i++) {
    const m = archive[i];
    if (m.role !== "user") continue;
    const userText = m.content?.trim() ?? "";
    if (userText.length < 4) continue;

    let assistantText: string | null = null;
    const next = archive[i + 1];
    if (next?.role === "assistant") {
      assistantText = next.content?.trim() ?? null;
      i++;
    }

    out.push({
      userText,
      assistantText,
      createdAt: m.created_at,
    });
  }
  return out;
}

function computeExcludeTail(
  totalMessages: number,
  requestedTail: number
): number {
  const tail = Math.max(0, requestedTail);
  if (totalMessages <= MIN_ARCHIVE_MESSAGES + 4) {
    return Math.max(0, totalMessages - MIN_ARCHIVE_MESSAGES);
  }
  if (totalMessages - tail < MIN_ARCHIVE_MESSAGES) {
    return Math.max(0, totalMessages - MIN_ARCHIVE_MESSAGES);
  }
  return tail;
}

function pickSpacedExchanges(exchanges: RawExchange[], count: number): RawExchange[] {
  if (exchanges.length <= count) return [...exchanges];
  const out: RawExchange[] = [];
  const step = exchanges.length / (count + 1);
  for (let i = 1; i <= count; i++) {
    const idx = Math.min(exchanges.length - 1, Math.floor(step * i));
    out.push(exchanges[idx]);
  }
  return out;
}

/** Force-pick archive for whatever terms the user asked about (any topic). */
function pickExcerptsMatchingTerms(
  exchanges: RawExchange[],
  terms: string[],
  max: number
): RawExchange[] {
  const significant = terms.filter((t) => t.length >= 3);
  if (!significant.length) return [];

  const ranked = exchanges
    .map((ex) => {
      const blob = `${ex.userText} ${ex.assistantText ?? ""}`.toLowerCase();
      let hits = 0;
      for (const t of significant) {
        if (blob.includes(t)) hits++;
      }
      return { ex, hits };
    })
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  return ranked.slice(0, max).map((r) => r.ex);
}

function mergePicks(
  keyword: ArchiveExcerpt[],
  extra: RawExchange[],
  max: number
): ArchiveExcerpt[] {
  const seen = new Set(keyword.map((e) => exchangeKey(e)));
  const out = [...keyword];

  for (const ex of extra) {
    if (out.length >= max) break;
    const key = exchangeKey(ex);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      userText: trimExcerpt(ex.userText, RETRIEVAL_MAX_EXCERPT_CHARS),
      assistantText: ex.assistantText
        ? trimExcerpt(ex.assistantText, RETRIEVAL_MAX_EXCERPT_CHARS)
        : null,
      createdAt: ex.createdAt,
      score: 0,
    });
  }

  return out.slice(0, max);
}

/** Score and rank past exchanges in this conversation only. */
export function rankArchiveExcerpts(
  messages: Array<{ role: "user" | "assistant"; content: string; created_at: string }>,
  query: string,
  excludeTailCount: number,
  options?: { light?: boolean }
): ArchiveExcerpt[] {
  if (messages.length < 4) return [];

  const recallIntent = hasRecallIntent(query);
  const light = options?.light === true && !recallIntent;
  const topiclessLight = light && query.trim().length >= 180;
  const terms = mergeSearchTerms(query, recallIntent);

  if (terms.length < 1 && !recallIntent && !topiclessLight) return [];

  const topCap = recallIntent
    ? RETRIEVAL_TOP_K_RECALL
    : light
    ? RETRIEVAL_TOP_K_LIGHT
    : RETRIEVAL_TOP_K;
  const charCap = recallIntent
    ? RETRIEVAL_MAX_TOTAL_CHARS
    : light
    ? RETRIEVAL_MAX_TOTAL_CHARS_LIGHT
    : RETRIEVAL_MAX_TOTAL_CHARS;

  const excludeTail = computeExcludeTail(messages.length, excludeTailCount);
  const archive =
    excludeTail > 0 ? messages.slice(0, -excludeTail) : messages;

  if (archive.length < 4) return [];

  const exchanges = extractArchiveExchanges(archive);
  if (!exchanges.length) return [];

  const newestAt = exchanges.length
    ? exchanges[exchanges.length - 1]!.createdAt
    : "";

  const scored: ArchiveExcerpt[] = exchanges
    .map((ex) => {
      let score =
        scoreText(ex.userText, terms) * 2 +
        scoreText(ex.assistantText ?? "", terms) +
        (recallIntent ? 1 : 0);
      if (recallIntent && queryAsksFightTopic(query) && FIGHT_ANCHOR_RE.test(ex.userText)) {
        score += 10;
      }
      score += recencyBoost(ex.createdAt, newestAt);
      return {
        userText: ex.userText,
        assistantText: ex.assistantText,
        createdAt: ex.createdAt,
        score,
      };
    })
    .filter((ex) => ex.score > 0 || recallIntent)
    .sort((a, b) => b.score - a.score);

  let keywordPicked: ArchiveExcerpt[] = [];
  let totalChars = 0;

  for (const ex of scored) {
    if (keywordPicked.length >= topCap) break;
    if (ex.score <= 0 && !recallIntent) continue;
    const blockLen =
      ex.userText.length + (ex.assistantText?.length ?? 0) + 48;
    if (totalChars + blockLen > charCap && keywordPicked.length >= (light ? 2 : 3)) {
      break;
    }
    keywordPicked.push({
      ...ex,
      userText: trimExcerpt(ex.userText, RETRIEVAL_MAX_EXCERPT_CHARS),
      assistantText: ex.assistantText
        ? trimExcerpt(ex.assistantText, RETRIEVAL_MAX_EXCERPT_CHARS)
        : null,
    });
    totalChars += blockLen;
  }

  const needMore =
    recallIntent || topiclessLight || keywordPicked.length < (light ? 2 : 3);
  if (needMore && exchanges.length > 0) {
    const recency = exchanges.slice(-6).reverse();
    const spaced = pickSpacedExchanges(exchanges, light ? 3 : 4);
    const fallback = recallIntent
      ? [...recency, ...spaced]
      : [...spaced, ...recency.slice(0, light ? 1 : 2)];

    keywordPicked = mergePicks(
      keywordPicked,
      fallback,
      recallIntent ? RETRIEVAL_TOP_K + 2 : Math.min(topCap, light ? 4 : 6)
    );
  }

  const topicTerms = terms.filter((t) => t.length >= 3);
  const needTopicBoost =
    recallIntent ||
    (!light && (keywordPicked.length < 4 || topicTerms.length > 0));

  if (needTopicBoost && topicTerms.length > 0) {
    const topic = pickExcerptsMatchingTerms(
      exchanges,
      topicTerms,
      recallIntent ? 8 : light ? 4 : 6
    );
    keywordPicked = mergePicks(keywordPicked, topic, topCap + (recallIntent ? 2 : 0));
  }

  return keywordPicked;
}

function exchangeDedupeKey(ex: ArchiveExcerpt): string {
  return `${ex.createdAt}:${ex.userText.slice(0, 48)}`;
}

/** Merge keyword + semantic hits — keyword first so topic matches are not crowded out. */
export function mergeArchiveExcerpts(
  keyword: ArchiveExcerpt[],
  semantic: ArchiveExcerpt[],
  recallIntent = false
): ArchiveExcerpt[] {
  const cap = recallIntent ? RETRIEVAL_TOP_K_RECALL : RETRIEVAL_TOP_K;
  const seen = new Set<string>();
  const out: ArchiveExcerpt[] = [];

  for (const ex of [...keyword, ...semantic]) {
    const key = exchangeDedupeKey(ex);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ex);
    if (out.length >= cap) break;
  }

  return out;
}

export interface ArchiveSearchResult {
  excerpts: ArchiveExcerpt[];
  userEvidenceQuotes: UserEvidenceQuote[];
}

export async function fetchConversationMessagesForRetrieval(
  supabase: SupabaseClient,
  conversationId: string
): Promise<Array<{ role: "user" | "assistant"; content: string; created_at: string }>> {
  const { data, error } = await supabase
    .from("messages")
    .select("sender, role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(RETRIEVAL_MAX_FETCH);

  if (error) {
    console.error("[retrieval] fetch messages:", error.message);
    return [];
  }

  return (data ?? []).map((row) => ({
    role: normalizeMessageRole(row),
    content: row.content ?? "",
    created_at: row.created_at as string,
  }));
}

export async function searchConversationArchive(
  supabase: SupabaseClient,
  params: {
    conversationId: string;
    query: string;
    excludeTailCount: number;
    /** Extra text: recent user lines, memory summary bullets, corrections */
    queryContext?: string[];
    userId?: string;
    embedConfig?: EmbeddingApiConfig;
    supabaseService?: SupabaseClient;
  }
): Promise<ArchiveSearchResult> {
  const contextBlob = (params.queryContext ?? []).join(" ");
  const recallIntent = hasRecallIntent(params.query);
  const mode = resolveArchiveRetrievalMode(params.query);

  if (mode === "off") {
    console.log(
      `[retrieval] conversation=${params.conversationId} skipped mode=off (summary+tail only)`
    );
    return { excerpts: [], userEvidenceQuotes: [] };
  }

  const light = mode === "light";

  const messages = await fetchConversationMessagesForRetrieval(
    supabase,
    params.conversationId
  );

  const keywordHits = rankArchiveExcerpts(
    messages,
    params.query,
    params.excludeTailCount,
    { light }
  );

  let semanticHits: ArchiveExcerpt[] = [];

  if (
    mode === "full" &&
    params.embedConfig?.apiKey &&
    params.supabaseService &&
    params.userId &&
    messages.length >= 6
  ) {
    try {
      await ensureConversationEmbeddings(params.supabaseService, {
        conversationId: params.conversationId,
        userId: params.userId,
        embedConfig: params.embedConfig,
        maxMessages: 35,
      });

      const rawRows = await params.supabaseService
        .from("messages")
        .select("id, conversation_id, sender, role, content, created_at")
        .eq("conversation_id", params.conversationId)
        .order("created_at", { ascending: true })
        .limit(RETRIEVAL_MAX_FETCH);

      const semanticQuery = [params.query, contextBlob.slice(0, 800)]
        .filter(Boolean)
        .join(" ");

      semanticHits = await searchSemanticConversationArchive(supabase, {
        conversationId: params.conversationId,
        query: semanticQuery.slice(0, 2000),
        excludeTailCount: params.excludeTailCount,
        embedConfig: params.embedConfig,
        allMessages: (rawRows.data ?? []) as Array<{
          id: string;
          conversation_id: string;
          sender?: string | null;
          role?: string | null;
          content: string;
          created_at: string;
        }>,
      });
    } catch (e) {
      console.warn("[retrieval] semantic path failed:", e);
    }
  }

  const excerpts = mergeArchiveExcerpts(
    keywordHits,
    semanticHits,
    recallIntent
  );

  let userEvidenceQuotes =
    mode === "full" || recallIntent
      ? collectUserEvidenceQuotes(
          messages.map((m) => ({
            role: m.role,
            content: m.content,
            created_at: m.created_at,
          })),
          params.query,
          contextBlob
        )
      : [];

  if (recallIntent && userEvidenceQuotes.length < 4 && keywordHits.length > 0) {
    userEvidenceQuotes = mergeEvidenceQuotes(
      userEvidenceQuotes,
      evidenceFromArchiveUserLines(keywordHits),
      14
    );
  }

  console.log(
    `[retrieval] conversation=${params.conversationId} mode=${mode} totalMsgs=${messages.length} ` +
      `keyword=${keywordHits.length} semantic=${semanticHits.length} merged=${excerpts.length} ` +
      `evidence=${userEvidenceQuotes.length} recall=${recallIntent}`
  );

  return { excerpts, userEvidenceQuotes };
}

export function formatArchiveExcerptsForPrompt(excerpts: ArchiveExcerpt[]): string {
  if (!excerpts.length) return "";

  const lines: string[] = [
    "АРХИВ ЭТОЙ БЕСЕДЫ (обязательно учти — только этот чат, не другие диалоги):",
    "Ниже — реальные прошлые реплики пользователя и ответы StaySee из ЭТОЙ беседы (подобраны по смыслу и словам).",
    "Если в архиве есть реплика «Пользователь: …» про тему — пользователь УЖЕ говорила это здесь. Не пиши «ты не говорила».",
    "Опирайся на архив по любой теме, о которой пользователь спрашивает — даже если формулировки другие.",
    "При противоречии с самыми последними репликами — уточни актуальность, не отрицай весь прошлый разговор.",
    "",
  ];

  for (const ex of excerpts) {
    const date = formatShortDate(ex.createdAt);
    if (date) lines.push(`[${date}]`);
    lines.push(`Пользователь: ${ex.userText}`);
    if (ex.assistantText) {
      lines.push(`StaySee: ${ex.assistantText}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function estimateArchiveTokens(excerpts: ArchiveExcerpt[]): number {
  if (!excerpts.length) return 0;
  return estimateTokens(formatArchiveExcerptsForPrompt(excerpts));
}

/** Flatten conversation summary JSON into search terms. */
export function summaryTextForRetrieval(
  conversationSummary: string | null | undefined
): string {
  if (!conversationSummary?.trim()) return "";
  try {
    if (conversationSummary.trim().startsWith("{")) {
      const o = JSON.parse(conversationSummary) as Record<string, string[]>;
      const parts: string[] = [];
      for (const key of [
        "people",
        "themes",
        "important_events",
        "open_loops",
        "emotional_state",
      ]) {
        const arr = o[key];
        if (Array.isArray(arr)) parts.push(...arr);
      }
      return parts.join(" ");
    }
  } catch {
    /* legacy prose */
  }
  return conversationSummary.slice(0, 800);
}
