/**
 * Fact evolution v1 — deterministic merge/replace for stable life-context slots.
 * Display/product language in outputs; no DB schema changes.
 */

import { normalizeCrossMemoryContent } from "./crossMemoryPolicy.ts";

export type FactSlot =
  | "relation.son"
  | "relation.daughter"
  | "relation.partner"
  | "relation.pet";

export type SonLivingStatus =
  | "lives_with_me"
  | "moved_out"
  | "in_army"
  | "unknown";

export type PartnerCohabitation =
  | "not_living_together"
  | "often_stays_overnight"
  | "living_together"
  | "unknown";

export interface ExistingFactRow {
  id?: string;
  content: string;
  memory_type: string;
}

export interface FactCandidate {
  memory_type: string;
  content: string;
}

export type FactEvolutionDecision =
  | { action: "add"; content: string; memory_type: "life_context" }
  | {
      action: "enrich" | "replace";
      content: string;
      memory_type: "life_context";
      deleteRowIds: string[];
      replacedContents: string[];
    }
  | { action: "ignore"; reason: string };

interface SonState {
  exists: boolean;
  age?: number;
  livingStatus: SonLivingStatus;
}

interface PartnerState {
  cohabitation: PartnerCohabitation;
}

interface PetState {
  exists: boolean;
  name?: string;
}

interface ParsedFact {
  slot: FactSlot;
  son?: Partial<SonState>;
  partner?: Partial<PartnerState>;
  pet?: Partial<PetState>;
}

const LIVING_RANK: Record<SonLivingStatus, number> = {
  unknown: 0,
  lives_with_me: 1,
  moved_out: 2,
  in_army: 3,
};

const COHAB_RANK: Record<PartnerCohabitation, number> = {
  unknown: 0,
  not_living_together: 1,
  often_stays_overnight: 2,
  living_together: 3,
};

function bare(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[.!?…]+$/u, "")
    .trim()
    .toLowerCase();
}

function normKey(text: string): string {
  return bare(normalizeCrossMemoryContent(text));
}

function hasSonSignal(t: string): boolean {
  return /(?:^|[\s,.(—–-])сын(?:$|[\s,.;:!?])/u.test(` ${t} `) || /сыну/u.test(t);
}

function hasDaughterSignal(t: string): boolean {
  return /(?:^|[\s,.(—–-])дочь(?:$|[\s,.;:!?])/u.test(` ${t} `) || /дочери/u.test(t);
}

function hasPartnerSignal(t: string): boolean {
  return /партн[ёе]р/u.test(t) || /живём\s+вместе/u.test(t) || /съехались/u.test(t);
}

function hasPetSignal(t: string): boolean {
  return /(?:^|[\s,.(—–-])(?:собака|кот|кошка|питомец)(?:$|[\s,.;:!?])/u.test(` ${t} `);
}

function isAmbiguousPartnerPronounOnly(t: string): boolean {
  return /^он\s+стал\s+часто\s+ночевать$/iu.test(bare(t));
}

function isCommunicationContent(t: string): boolean {
  return (
    /\b(?:прямот|присутств|совет|женск(?:ом|ому)|мужск(?:ом|ому)|пуст(?:ые|ых)\s+слов|нить\s+разговор)\b/iu.test(
      t
    ) && !hasSonSignal(t) && !hasPartnerSignal(t) && !hasPetSignal(t)
  );
}

function parseAge(t: string): number | undefined {
  const m =
    t.match(/сыну?\s+(\d{1,2})/u) ??
    t.match(/дочери?\s+(\d{1,2})/u) ??
    t.match(/сын,?\s+(\d{1,2})\s+лет/u) ??
    t.match(/дочь,?\s+(\d{1,2})\s+лет/u) ??
    t.match(/(\d{1,2})\s+лет/u);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 && n < 100 ? n : undefined;
}

function parseSonLiving(t: string): SonLivingStatus {
  if (/(?:сын.*)?(?:ушёл|ушел|сейчас).*(?:арми|армии)|(?:сын.*)?в\s+армии/iu.test(t)) {
    return "in_army";
  }
  if (/сын.*(?:съехал|съехала)/iu.test(t)) return "moved_out";
  if (/(?:сын.*)?(?:живёт|живет)\s+со\s+мной/iu.test(t)) return "lives_with_me";
  return "unknown";
}

function parsePartnerCohabitation(
  t: string,
  opts: { allowAmbiguousPronoun: boolean }
): PartnerCohabitation | null {
  if (isAmbiguousPartnerPronounOnly(t) && !opts.allowAmbiguousPronoun) {
    return null;
  }
  if (/(?:^|[\s,.(—–-])(?:живём|живем)\s+вместе/u.test(` ${t} `) || /съехались/u.test(t)) {
    return "living_together";
  }
  if (
    /партн[ёе]р.*(?:часто).*(?:ночев|остаётся|остается)/iu.test(t) ||
    /часто\s+ночевать/iu.test(t)
  ) {
    return "often_stays_overnight";
  }
  if (/партн[ёе]р.*не\s+жив/iu.test(t) || /не\s+жив(?:ёт|ет)\s+вместе/u.test(t)) {
    return "not_living_together";
  }
  return "unknown";
}

function parseFactFromText(
  text: string,
  opts: { allowAmbiguousPronoun: boolean }
): ParsedFact | null {
  const raw = text.replace(/\s+/g, " ").trim();
  const t = raw.toLowerCase();
  if (!t || isCommunicationContent(t)) return null;

  if (hasPetSignal(t)) {
    let name: string | undefined;
    const named =
      raw.match(/собаку?\s+зовут\s+([\p{L}][\p{L}-]{0,30})/iu) ??
      raw.match(/есть\s+собака\s+([\p{L}][\p{L}-]{0,30})/iu) ??
      raw.match(/собака\s+([\p{L}][\p{L}-]{0,30})/iu);
    if (named) name = named[1];
    return { slot: "relation.pet", pet: { exists: true, name } };
  }

  if (hasPartnerSignal(t) || isAmbiguousPartnerPronounOnly(t)) {
    const cohabitation = parsePartnerCohabitation(t, opts);
    if (cohabitation === null) return null;
    if (cohabitation === "unknown" && !hasPartnerSignal(t)) return null;
    return { slot: "relation.partner", partner: { cohabitation } };
  }

  if (hasDaughterSignal(t)) {
    return {
      slot: "relation.daughter",
      son: {
        exists: true,
        age: parseAge(t),
        livingStatus: parseSonLiving(t.replace(/\bдочь\b/gu, "сын")),
      },
    };
  }

  if (hasSonSignal(t) || /есть\s+сын/u.test(t)) {
    return {
      slot: "relation.son",
      son: {
        exists: true,
        age: parseAge(t),
        livingStatus: parseSonLiving(t),
      },
    };
  }

  return null;
}

function mergeSonState(current: SonState, update: Partial<SonState>): SonState {
  const livingStatus =
    update.livingStatus && update.livingStatus !== "unknown"
      ? LIVING_RANK[update.livingStatus] >= LIVING_RANK[current.livingStatus]
        ? update.livingStatus
        : current.livingStatus
      : current.livingStatus;

  return {
    exists: current.exists || update.exists === true,
    age: update.age ?? current.age,
    livingStatus,
  };
}

function mergePartnerState(
  current: PartnerState,
  update: Partial<PartnerState>
): PartnerState {
  const next = update.cohabitation ?? "unknown";
  const cohabitation =
    next !== "unknown" && COHAB_RANK[next] >= COHAB_RANK[current.cohabitation]
      ? next
      : current.cohabitation;
  return { cohabitation };
}

function mergePetState(current: PetState, update: Partial<PetState>): PetState {
  return {
    exists: current.exists || update.exists === true,
    name: update.name ?? current.name,
  };
}

function defaultSonState(): SonState {
  return { exists: false, livingStatus: "unknown" };
}

function defaultPartnerState(): PartnerState {
  return { cohabitation: "unknown" };
}

function defaultPetState(): PetState {
  return { exists: false };
}

export function renderSonState(state: SonState, label: "сын" | "дочь" = "сын"): string {
  if (!state.exists) return "";
  const parts: string[] = [label];
  if (state.age != null) parts.push(`${state.age} лет`);
  if (state.livingStatus === "lives_with_me") parts.push("живёт со мной");
  else if (state.livingStatus === "moved_out") parts.push("съехал");
  else if (state.livingStatus === "in_army") parts.push("сейчас в армии");
  if (parts.length === 1) return `есть ${label}`;
  return parts.join(", ");
}

export function renderPartnerState(state: PartnerState): string {
  switch (state.cohabitation) {
    case "not_living_together":
      return "партнёр не живёт вместе";
    case "often_stays_overnight":
      return "партнёр часто остаётся на ночь";
    case "living_together":
      return "живём вместе с партнёром";
    default:
      return "";
  }
}

export function renderPetState(state: PetState): string {
  if (!state.exists) return "";
  if (state.name) return `есть собака ${state.name}`;
  return "есть собака";
}

export function rowMatchesFactSlot(content: string, slot: FactSlot): boolean {
  const t = bare(content);
  switch (slot) {
    case "relation.son":
      return hasSonSignal(t) || /есть\s+сын/u.test(t);
    case "relation.daughter":
      return hasDaughterSignal(t) || /есть\s+дочь/u.test(t);
    case "relation.partner":
      return (
        hasPartnerSignal(t) ||
        /не\s+жив(?:ёт|ет)\s+вместе/u.test(t) ||
        /живём\s+вместе/u.test(t)
      );
    case "relation.pet":
      return hasPetSignal(t);
    default:
      return false;
  }
}

function aggregateSonFromRows(
  rows: ExistingFactRow[],
  slot: "relation.son" | "relation.daughter"
): SonState {
  let state = defaultSonState();
  for (const row of rows) {
    if (!rowMatchesFactSlot(row.content, slot)) continue;
    const parsed = parseFactFromText(row.content, { allowAmbiguousPronoun: true });
    if (!parsed?.son) continue;
    state = mergeSonState(state, parsed.son);
    state.exists = true;
  }
  return state;
}

function aggregatePartnerFromRows(rows: ExistingFactRow[]): PartnerState {
  let state = defaultPartnerState();
  for (const row of rows) {
    if (!rowMatchesFactSlot(row.content, "relation.partner")) continue;
    const parsed = parseFactFromText(row.content, { allowAmbiguousPronoun: true });
    if (!parsed?.partner?.cohabitation) continue;
    state = mergePartnerState(state, parsed.partner);
  }
  return state;
}

function aggregatePetFromRows(rows: ExistingFactRow[]): PetState {
  let state = defaultPetState();
  for (const row of rows) {
    if (!rowMatchesFactSlot(row.content, "relation.pet")) continue;
    const parsed = parseFactFromText(row.content, { allowAmbiguousPronoun: true });
    if (!parsed?.pet) continue;
    state = mergePetState(state, parsed.pet);
  }
  return state;
}

function renderSlotState(
  slot: FactSlot,
  son: SonState,
  partner: PartnerState,
  pet: PetState
): string {
  switch (slot) {
    case "relation.son":
      return renderSonState(son, "сын");
    case "relation.daughter":
      return renderSonState(son, "дочь");
    case "relation.partner":
      return renderPartnerState(partner);
    case "relation.pet":
      return renderPetState(pet);
    default:
      return "";
  }
}

function hasPartnerContext(rows: ExistingFactRow[]): boolean {
  return rows.some((r) => rowMatchesFactSlot(r.content, "relation.partner"));
}

/** Classify a life-context candidate into a stable fact slot (or null). */
export function classifyFactCandidate(content: string): FactSlot | null {
  const parsed = parseFactFromText(content, { allowAmbiguousPronoun: false });
  return parsed?.slot ?? null;
}

/** Narrative/conflict/course episodes — never promote from important_events. */
function isBlockedFactEventNarrative(text: string): boolean {
  const t = bare(text);
  if (!t) return true;
  if (t.length > 160) return true;
  if (
    /(?:племянниц|купил[аи]?\s+курс|преподавател|дипломом\s+психолог|причинив\s+боль)/iu.test(
      t
    )
  ) {
    return true;
  }
  if (
    /(?:расстроил|обидел|ссор|конфликт|драма|переживает)/iu.test(t) &&
    !/(?:живёт|живет|арми|сыну\s+\d|съехались|ночев|остаётся|остается)/iu.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * True when text may be promoted from conversation_summary.important_events
 * into a stable fact-evolution slot (not generic narrative).
 */
export function isFactEvolutionCandidateText(text: string): boolean {
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw || isBlockedFactEventNarrative(raw)) return false;

  const parsed = parseFactFromText(raw, { allowAmbiguousPronoun: false });
  if (!parsed) return false;

  if (parsed.slot === "relation.pet") {
    return parsed.pet?.exists === true;
  }

  if (parsed.slot === "relation.partner") {
    return (
      parsed.partner?.cohabitation !== undefined &&
      parsed.partner.cohabitation !== "unknown"
    );
  }

  if (parsed.slot === "relation.son" || parsed.slot === "relation.daughter") {
    const son = parsed.son;
    if (!son) return false;
    if (son.age != null) return true;
    if (son.livingStatus != null && son.livingStatus !== "unknown") return true;
    const b = bare(raw);
    if (/^(?:есть\s+)?(?:сын|дочь)$/u.test(b)) return true;
    if (/^у\s+меня\s+есть\s+(?:сын|дочь)$/u.test(b)) return true;
    return false;
  }

  return false;
}

/**
 * Decide how a new candidate should evolve existing life-context rows.
 * Returns null for non-evolvable types (communication/preference) — caller uses legacy insert.
 */
export function evolveMemoryFacts(
  existingRows: ExistingFactRow[],
  candidate: FactCandidate
): FactEvolutionDecision | null {
  if (candidate.memory_type !== "life_context") return null;

  const partnerContext = hasPartnerContext(existingRows);
  const parsed = parseFactFromText(candidate.content, {
    allowAmbiguousPronoun: partnerContext,
  });

  if (!parsed) {
    if (isAmbiguousPartnerPronounOnly(candidate.content)) {
      return { action: "ignore", reason: "ambiguous pronoun without partner context" };
    }
    return null;
  }

  const slot = parsed.slot;
  const slotRows = existingRows.filter(
    (r) =>
      r.memory_type === "life_context" && rowMatchesFactSlot(r.content, slot)
  );

  let son = defaultSonState();
  let partner = defaultPartnerState();
  let pet = defaultPetState();

  if (slot === "relation.son" || slot === "relation.daughter") {
    son = aggregateSonFromRows(slotRows, slot);
    if (parsed.son) son = mergeSonState(son, parsed.son);
    son.exists = true;
  } else if (slot === "relation.partner") {
    partner = aggregatePartnerFromRows(slotRows);
    if (parsed.partner) partner = mergePartnerState(partner, parsed.partner);
  } else if (slot === "relation.pet") {
    pet = aggregatePetFromRows(slotRows);
    if (parsed.pet) pet = mergePetState(pet, parsed.pet);
    pet.exists = true;
  }

  const rendered = renderSlotState(slot, son, partner, pet);
  if (!rendered) {
    return { action: "ignore", reason: "empty rendered state" };
  }

  const renderedKey = normKey(rendered);
  const already = slotRows.some((r) => normKey(r.content) === renderedKey);
  if (already) {
    return { action: "ignore", reason: "already current" };
  }

  if (!slotRows.length) {
    return { action: "add", content: rendered, memory_type: "life_context" };
  }

  const prevRendered = renderSlotState(
    slot,
    slot === "relation.son" || slot === "relation.daughter"
      ? aggregateSonFromRows(slotRows, slot as "relation.son" | "relation.daughter")
      : son,
    slot === "relation.partner" ? aggregatePartnerFromRows(slotRows) : partner,
    slot === "relation.pet" ? aggregatePetFromRows(slotRows) : pet
  );
  const prevKey = normKey(prevRendered);

  const isReplace =
    (parsed.son?.livingStatus &&
      parsed.son.livingStatus !== "unknown" &&
      parsed.son.livingStatus !== aggregateSonFromRows(
        slotRows,
        slot as "relation.son" | "relation.daughter"
      ).livingStatus) ||
    (parsed.partner?.cohabitation &&
      parsed.partner.cohabitation !== "unknown" &&
      parsed.partner.cohabitation !== aggregatePartnerFromRows(slotRows).cohabitation &&
      renderedKey !== prevKey);

  const deleteRowIds = slotRows.map((r) => r.id).filter((id): id is string => !!id);
  const replacedContents = slotRows.map((r) => r.content);

  return {
    action: isReplace ? "replace" : "enrich",
    content: rendered,
    memory_type: "life_context",
    deleteRowIds,
    replacedContents,
  };
}

/** Collapse contradictory life-context rows for injection (read path). */
export function collapseEvolvedLifeContextRows<
  T extends { content: string; memory_type: string }
>(rows: T[]): T[] {
  const lifeRows = rows.filter((r) => r.memory_type === "life_context");
  const other = rows.filter((r) => r.memory_type !== "life_context");

  const slots: FactSlot[] = [
    "relation.son",
    "relation.daughter",
    "relation.partner",
    "relation.pet",
  ];

  const drop = new Set<T>();
  const addSynthetic: T[] = [];

  for (const slot of slots) {
    const matched = lifeRows.filter((r) => rowMatchesFactSlot(r.content, slot));
    if (matched.length <= 1) continue;

    let son = defaultSonState();
    let partner = defaultPartnerState();
    let pet = defaultPetState();

    if (slot === "relation.son" || slot === "relation.daughter") {
      son = aggregateSonFromRows(matched, slot);
    } else if (slot === "relation.partner") {
      partner = aggregatePartnerFromRows(matched);
    } else {
      pet = aggregatePetFromRows(matched);
    }

    const rendered = renderSlotState(slot, son, partner, pet);
    if (!rendered) continue;

    const canonicalKey = normKey(rendered);
    const keeper =
      matched.find((r) => normKey(r.content) === canonicalKey) ?? matched[0];

    for (const row of matched) {
      if (row !== keeper) drop.add(row);
    }

    if (normKey(keeper.content) !== canonicalKey) {
      drop.add(keeper);
      addSynthetic.push({
        ...keeper,
        content: normalizeCrossMemoryContent(rendered),
      });
    }
  }

  const out = rows.filter((r) => !drop.has(r));
  return [...out, ...addSynthetic];
}