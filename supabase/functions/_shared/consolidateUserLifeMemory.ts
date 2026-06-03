/**
 * One-shot: merge fragment user_memory rows into life-context sentences.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  CROSS_MEMORY_MAX_CHARS,
  CROSS_MEMORY_MIN_CHARS,
  isLifeMemoryFragment,
  parseLifeMemoryFromModel,
  type CrossMemoryType,
  type LifeMemoryModelConfig,
} from "./userLifeMemory.ts";

export interface UserMemoryRow {
  id: string;
  user_id: string;
  memory_type: string;
  content: string;
}

export interface ConsolidateUserResult {
  userId: string;
  kept: number;
  removed: number;
  added: number;
  skipped?: string;
}

function normalizeSentence(s: string): string {
  let t = s.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (!/[.!?…]$/.test(t)) t += ".";
  return t.slice(0, CROSS_MEMORY_MAX_CHARS);
}

function similarMemory(a: string, b: string): boolean {
  const x = a.toLowerCase().slice(0, 80);
  const y = b.toLowerCase().slice(0, 80);
  return x === y || x.includes(y.slice(0, 40)) || y.includes(x.slice(0, 40));
}

function buildConsolidationPrompt(
  kept: UserMemoryRow[],
  fragments: UserMemoryRow[]
): string {
  const keptBlock =
    kept.length > 0
      ? kept.map((r) => `• [${r.memory_type}] ${r.content}`).join("\n")
      : "(пусто)";
  const fragBlock = fragments
    .map((r) => `• [${r.memory_type}] ${r.content}`)
    .join("\n");

  return `Ты пересобираешь СКВОЗНУЮ ПАМЯТЬ пользователя.

Старые записи-фрагменты (отдельные слова, имена без контекста) нужно объединить в связные предложения.

УЖЕ ХОРОШИЕ ЗАПИСИ (не дублируй, не удаляй смысл):
${keptBlock}

ФРАГМЕНТЫ ДЛЯ ПЕРЕСБОРКИ:
${fragBlock}

Верни ТОЛЬКО JSON-массив (1–${Math.min(6, fragments.length + 1)} элементов):
[
  { "memory_type": "communication|preference|life_context|theme|emotion|insight", "content": "цельное предложение 40–280 символов" }
]

Правила:
- Объединяй фрагменты в осмысленные предложения о жизни, отношениях, стиле общения.
- Не оставляй отдельные слова. Не выдумывай факты — только из фрагментов и хороших записей.
- communication/preference — как лучше говорить с человеком, если есть намёк в данных.`.trim();
}

async function callConsolidationModel(
  prompt: string,
  model: LifeMemoryModelConfig
): Promise<string> {
  const res = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${model.apiKey}`,
      "Content-Type": "application/json",
      ...(model.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: model.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 700,
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`model ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Rule-based fallback when no API key. */
function ruleBasedMerge(rows: UserMemoryRow[]): Array<{
  memory_type: CrossMemoryType;
  content: string;
}> {
  const byType = new Map<string, string[]>();
  for (const r of rows) {
    const list = byType.get(r.memory_type) ?? [];
    list.push(r.content.trim());
    byType.set(r.memory_type, list);
  }
  const out: Array<{ memory_type: CrossMemoryType; content: string }> = [];
  const allPeople = [...(byType.get("insight") ?? []), ...(byType.get("life_context") ?? [])];
  if (allPeople.length) {
    out.push({
      memory_type: "life_context",
      content: normalizeSentence(
        `В жизни пользователя значимы: ${allPeople.join(", ")}.`
      ),
    });
  }
  const themes = byType.get("theme") ?? [];
  if (themes.length) {
    out.push({
      memory_type: "theme",
      content: normalizeSentence(`Жизненные темы: ${themes.join("; ")}.`),
    });
  }
  const prefs = [
    ...(byType.get("preference") ?? []),
    ...(byType.get("communication") ?? []),
  ];
  if (prefs.length) {
    out.push({
      memory_type: "communication",
      content: normalizeSentence(
        `В общении важно: ${prefs.join("; ")}.`
      ),
    });
  }
  const emo = byType.get("emotion") ?? [];
  if (emo.length) {
    out.push({
      memory_type: "emotion",
      content: normalizeSentence(
        `Эмоциональный фон: ${emo.join("; ")}.`
      ),
    });
  }
  return out.filter((x) => x.content.length >= CROSS_MEMORY_MIN_CHARS);
}

function needsFullRebuild(rows: UserMemoryRow[]): boolean {
  const fragments = rows.filter((r) => isLifeMemoryFragment(r.content));
  if (fragments.length > 0) return true;
  return rows.some((r) => r.content.length < CROSS_MEMORY_MIN_CHARS + 10);
}

export async function consolidateUserLifeMemoryRows(
  supabase: SupabaseClient,
  userId: string,
  rows: UserMemoryRow[],
  model?: LifeMemoryModelConfig,
  dryRun = false,
  forceRebuild = false
): Promise<ConsolidateUserResult> {
  const fragments = rows.filter((r) => isLifeMemoryFragment(r.content));
  const fullRebuild = forceRebuild || needsFullRebuild(rows);

  if (!fragments.length && !fullRebuild) {
    return {
      userId,
      kept: rows.length,
      removed: 0,
      added: 0,
      skipped: "no_fragments",
    };
  }

  const sourceRows = fullRebuild ? rows : fragments;
  const kept = fullRebuild ? [] : rows.filter((r) => !isLifeMemoryFragment(r.content));

  let candidates: Array<{
    memory_type: CrossMemoryType;
    content: string;
    importance: number;
  }> = [];

  if (model?.apiKey) {
    try {
      const prompt = buildConsolidationPrompt(kept, sourceRows);
      const raw = await callConsolidationModel(prompt, model);
      candidates = parseLifeMemoryFromModel(raw);
      if (candidates.length < 2 && sourceRows.length > 3) {
        const retry = await callConsolidationModel(
          `${prompt}\n\nВажно: верни минимум 3 разных предложения, объединяя все фрагменты.`,
          model
        );
        const more = parseLifeMemoryFromModel(retry);
        if (more.length > candidates.length) candidates = more;
      }
    } catch (e) {
      console.warn(`[consolidate] user=${userId} model failed:`, e);
    }
  }

  if (!candidates.length) {
    candidates = ruleBasedMerge(sourceRows).map((c) => ({
      ...c,
      importance: 4,
    }));
  }

  const known = kept.map((r) => r.content.trim().toLowerCase());
  let toInsert = candidates.filter((c) => {
    if (isLifeMemoryFragment(c.content)) return false;
    return !known.some((k) => similarMemory(k, c.content));
  });

  if (!toInsert.length) {
    toInsert = ruleBasedMerge(sourceRows).filter(
      (c) => !isLifeMemoryFragment(c.content)
    );
  }

  const removeIds = fullRebuild
    ? rows.map((r) => r.id)
    : fragments.map((r) => r.id);

  if (dryRun) {
    return {
      userId,
      kept: fullRebuild ? 0 : kept.length,
      removed: removeIds.length,
      added: toInsert.length,
    };
  }

  if (!toInsert.length) {
    return {
      userId,
      kept: rows.length,
      removed: 0,
      added: 0,
      skipped: "no_candidates",
    };
  }

  if (removeIds.length) {
    const { error: delErr } = await supabase
      .from("user_memory")
      .delete()
      .in("id", removeIds);
    if (delErr) throw delErr;
  }

  let added = 0;
  for (const c of toInsert) {
    const { error } = await supabase.from("user_memory").insert({
      user_id: userId,
      memory_type: c.memory_type,
      content: c.content,
    });
    if (error) {
      console.error(`[consolidate] insert failed user=${userId}:`, error.message);
      throw error;
    }
    added++;
  }

  return {
    userId,
    kept: fullRebuild ? 0 : kept.length,
    removed: removeIds.length,
    added,
  };
}

export async function consolidateAllUserLifeMemory(
  supabase: SupabaseClient,
  model?: LifeMemoryModelConfig,
  opts?: { userId?: string; dryRun?: boolean; forceRebuild?: boolean }
): Promise<ConsolidateUserResult[]> {
  let q = supabase
    .from("user_memory")
    .select("id, user_id, memory_type, content")
    .order("created_at", { ascending: true });

  if (opts?.userId) q = q.eq("user_id", opts.userId);

  const { data, error } = await q;
  if (error) throw error;

  const byUser = new Map<string, UserMemoryRow[]>();
  for (const row of data ?? []) {
    const uid = row.user_id as string;
    const list = byUser.get(uid) ?? [];
    list.push(row as UserMemoryRow);
    byUser.set(uid, list);
  }

  const results: ConsolidateUserResult[] = [];
  for (const [userId, rows] of byUser) {
    const r = await consolidateUserLifeMemoryRows(
      supabase,
      userId,
      rows,
      model,
      opts?.dryRun ?? false,
      opts?.forceRebuild ?? false
    );
    if (!r.skipped || r.removed > 0) results.push(r);
  }
  return results;
}
