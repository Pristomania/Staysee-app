/**
 * Archive search within ONE conversation only.
 * Never searches other chats or merges conversation summaries.
 *
 * What is searched: when someone asks to remember, the WHOLE conversation (newest RETRIEVAL_MAX_FETCH messages by words,
 * everything by meaning through the vectors); otherwise only the recent window. Nothing here is written for one story:
 * no topic is guessed from the words, and no word is added to the person's own.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { estimateTokens } from "./tokenEstimate.ts";
import type { EmbeddingApiConfig } from "./embeddings.ts";
import {
  ensureConversationEmbeddings,
  searchSemanticConversationArchive,
} from "./messageEmbeddings.ts";
import { normalizeMessageRole } from "./messageRole.ts";

/** The newest messages read for the search by words when the person did not ask to remember. */
export const RETRIEVAL_RECENT_WINDOW = 400;
/** The newest messages read for the search by words when the person asked to remember. Older ones are reached by meaning. */
export const RETRIEVAL_MAX_FETCH = 6_000;
const FETCH_PAGE = 1_000;
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
  /помнишь|помните|помни|забыла|забыл|говорил[аи]?|говорила|сказал[аи]?|сказала|обсуждал[аи]?|обсуждали|раньше|прошл(ый|ом|ую|ого|ым)|в прошл|прошлом году|прошлым летом|напомни|не помню|ты писал|ты написал|мы говорили|посмотри|говорила тебе|сказала тебе|я говорила|как было|что было|что случилось|тогда|в том числе|ещё раз|еще раз|продолжим|продолжить тему|рассказала|рассказывала|что я говорила|что ты помнишь|у меня этого нет|прошлого раза|вчера\s+(?:я\s+)?рассказывала|рассказывала\s+вчера|что\s+я\s+рассказывала/i;

/** Topic return without explicit «помнишь» — light archive only. */
const CONTINUITY_INTENT_RE =
  /продолжим|продолжить|вернёмся|вернемся|как вчера|вчера мы|на прошлой неделе|мы обсуждали|снова про|ещё про|еще про|та же тема|о том что|про то что/i;

/** User corrects memory («я ещё писала…», «не только это») — full retrieval. */
const MEMORY_CORRECTION_RE =
  /ещ[её]\s+писал|я\s+(?:уже\s+)?писал|не\s+только\s+это|забыл[аи]?\s+что|ты\s+не\s+то\s+помнишь|а\s+я\s+(?:же\s+)?(?:писала|говорила)/i;

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

type RetrievalMessage = { role: "user" | "assistant"; content: string; created_at: string };

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

/** Prefer fresh lines when scores are close. Not used when the person asks to remember: then an old line is as good as a new one. */
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

function scoreQuoteAgainstTerms(content: string, terms: string[]): number {
  const lower = content.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (t.length >= 4 && lower.includes(t)) score += 3;
    else if (t.length >= 3 && lower.includes(t)) score += 1;
  }
  return score;
}

export interface UserEvidenceQuote {
  createdAt: string;
  text: string;
}

/** Verbatim lines of the person that carry the words of the question — for recall questions. */
export function collectUserEvidenceQuotes(
  messages: RetrievalMessage[],
  query: string,
  cap = 16
): UserEvidenceQuote[] {
  const terms = tokenizeQuery(query).filter((t) => t.length >= 3);
  if (terms.length < 1) return [];

  const ranked: Array<UserEvidenceQuote & { score: number }> = [];
  const seen = new Set<string>();

  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = m.content?.trim() ?? "";
    if (text.length < 8) continue;
    const score = scoreQuoteAgainstTerms(text, terms);
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

export function formatUserEvidenceForPrompt(quotes: UserEvidenceQuote[]): string {
  if (!quotes.length) return "";

  const lines: string[] = [
    "ПОДТВЕРЖДЁННЫЕ СЛОВА ПОЛЬЗОВАТЕЛЯ В ЭТОЙ БЕСЕДЕ (дословно, только этот чат):",
    "Это реальные сообщения человека из истории этой беседы. Если блок не пуст — об этом здесь уже говорили.",
    "Запрещено отрицать, что об этом говорили («не помню», «у меня этого нет»), если ниже есть цитаты по той же теме или за тот же период.",
    "Запрещено: выдумывать людей и факты, которых нет в цитатах.",
    "Если цитаты про разные темы — не сливай их в одно: отвечай по теме вопроса.",
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
      year: "numeric",
    });
  } catch {
    return "";
  }
}

function exchangeKey(ex: RawExchange): string {
  return `${ex.createdAt}:${ex.userText.slice(0, 40)}`;
}

function extractArchiveExchanges(archive: RetrievalMessage[]): RawExchange[] {
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

function computeExcludeTail(totalMessages: number, requestedTail: number): number {
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

/** Score and rank past exchanges in this conversation only, by the words of the question. */
export function rankArchiveExcerpts(
  messages: RetrievalMessage[],
  query: string,
  excludeTailCount: number,
  options?: { light?: boolean }
): ArchiveExcerpt[] {
  if (messages.length < 4) return [];

  const recallIntent = hasRecallIntent(query);
  const light = options?.light === true && !recallIntent;
  const topiclessLight = light && query.trim().length >= 180;
  const terms = tokenizeQuery(query);

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
      if (!recallIntent) score += recencyBoost(ex.createdAt, newestAt);
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

export type RetrievalFetchScope = "recent" | "all";

/**
 * The messages of one conversation, oldest first. "recent" reads the newest RETRIEVAL_RECENT_WINDOW; "all" reads
 * newest-first in pages of 1000 up to RETRIEVAL_MAX_FETCH, so a long conversation is not cut to its first messages.
 */
export async function fetchConversationMessagesForRetrieval(
  supabase: SupabaseClient,
  conversationId: string,
  scope: RetrievalFetchScope = "recent"
): Promise<RetrievalMessage[]> {
  const cap = scope === "all" ? RETRIEVAL_MAX_FETCH : RETRIEVAL_RECENT_WINDOW;
  const rows: Array<{ sender?: string | null; role?: string | null; content: string | null; created_at: string }> = [];

  for (let from = 0; from < cap; from += FETCH_PAGE) {
    const to = Math.min(from + FETCH_PAGE, cap) - 1;
    const { data, error } = await supabase
      .from("messages")
      .select("sender, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to);

    if (error) {
      console.error("[retrieval] fetch messages:", error.message);
      break;
    }
    const page = (data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < to - from + 1) break;
  }

  return rows.reverse().map((row) => ({
    role: normalizeMessageRole(row),
    content: row.content ?? "",
    created_at: row.created_at,
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
    params.conversationId,
    light ? "recent" : "all"
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
      // Catch up the vectors of messages that have none yet (newest first), then compare by meaning across the whole history.
      await ensureConversationEmbeddings(params.supabaseService, {
        conversationId: params.conversationId,
        userId: params.userId,
        embedConfig: params.embedConfig,
        maxMessages: 40,
      });

      const tail = Math.max(0, params.excludeTailCount);
      const cutoff =
        tail > 0 && messages.length > tail
          ? messages[messages.length - tail].created_at
          : null;

      const semanticQuery = [params.query, contextBlob.slice(0, 800)]
        .filter(Boolean)
        .join(" ");

      semanticHits = await searchSemanticConversationArchive(supabase, {
        conversationId: params.conversationId,
        query: semanticQuery.slice(0, 2000),
        beforeCreatedAt: cutoff,
        embedConfig: params.embedConfig,
        maxExcerptChars: RETRIEVAL_MAX_EXCERPT_CHARS,
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

  const userEvidenceQuotes =
    mode === "full" || recallIntent
      ? mergeEvidenceQuotes(
          collectUserEvidenceQuotes(messages, params.query),
          evidenceFromArchiveUserLines(excerpts),
          16
        )
      : [];

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
    "Ниже — реальные прошлые реплики человека и ответы StaySee из ЭТОЙ беседы (подобраны по смыслу и словам), с датами.",
    "Если в архиве есть реплика «Пользователь: …» по теме — это уже было сказано здесь. Не отрицай этого.",
    "Опирайся на архив по любой теме, о которой человек спрашивает — даже если формулировки другие.",
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
