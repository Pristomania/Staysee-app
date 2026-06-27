/**
 * Progress Analytics — подсчёт инсайтов и напряжений
 * Используется ТОЛЬКО для аналитики, не входит в контекст модели
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface ProgressStats {
  insightCount: number;
  tensionCount: number;
  totalCount: number;
  insightPercentage: number;
  tensionPercentage: number;
  periodDays: number;
}

/**
 * Получить статистику инсайтов и напряжений за период
 * @param supabase Supabase клиент
 * @param userId ID пользователя
 * @param conversationId ID беседы (опционально, если не указан — всех бесед)
 * @param days Количество дней назад (по умолчанию 30)
 */
export async function getProgressStats(
  supabase: SupabaseClient,
  userId: string,
  conversationId?: string | null,
  days: number = 30
): Promise<ProgressStats> {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);
  const sinceIso = sinceDate.toISOString();

  let query = supabase
    .from("progress_entries")
    .select("entry_type")
    .eq("user_id", userId)
    .gte("created_at", sinceIso);

  if (conversationId) {
    query = query.eq("conversation_id", conversationId);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[progressAnalytics] getProgressStats:", error.message);
    return {
      insightCount: 0,
      tensionCount: 0,
      totalCount: 0,
      insightPercentage: 0,
      tensionPercentage: 0,
      periodDays: days,
    };
  }

  const entries = data ?? [];
  const insightCount = entries.filter((e) => e.entry_type === "insight").length;
  const tensionCount = entries.filter((e) => e.entry_type === "tension").length;
  const totalCount = entries.length;

  return {
    insightCount,
    tensionCount,
    totalCount,
    insightPercentage: totalCount > 0 ? Math.round((insightCount / totalCount) * 100) : 0,
    tensionPercentage: totalCount > 0 ? Math.round((tensionCount / totalCount) * 100) : 0,
    periodDays: days,
  };
}

/**
 * Получить статистику по всем беседам пользователя
 * Возвращает список беседы + статистика для каждой
 */
export async function getAllConversationsStats(
  supabase: SupabaseClient,
  userId: string,
  days: number = 30
): Promise<Array<{ conversationId: string; conversationTitle: string } & ProgressStats>> {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);
  const sinceIso = sinceDate.toISOString();

  // Получить все беседы пользователя
  const { data: conversations, error: convError } = await supabase
    .from("conversations")
    .select("id, title")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (convError || !conversations) {
    console.error("[progressAnalytics] getAllConversationsStats:", convError?.message);
    return [];
  }

  // Для каждой беседы получить статистику
  const results = await Promise.all(
    conversations.map(async (conv) => {
      const stats = await getProgressStats(supabase, userId, conv.id, days);
      return {
        conversationId: conv.id,
        conversationTitle: conv.title || "Без названия",
        ...stats,
      };
    })
  );

  return results;
}

/**
 * Получить общую статистику по пользователю (все беседы)
 */
export async function getUserTotalStats(
  supabase: SupabaseClient,
  userId: string,
  days: number = 30
): Promise<ProgressStats> {
  return getProgressStats(supabase, userId, null, days);
}
