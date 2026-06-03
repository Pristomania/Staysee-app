import { supabase } from './supabase';
import { resolveSupabasePublicConfig } from './supabaseEnv';

export interface WeeklyReflectionResult {
  text: string | null;
  generated: boolean;
  error: string | null;
}

/** AI-сборка динамики недели в одной беседе (edge function). */
export async function requestWeeklyReflection(
  conversationId: string,
  userId: string,
): Promise<WeeklyReflectionResult> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const { url: supabaseUrl, anonKey } = resolveSupabasePublicConfig();

  if (!token || !supabaseUrl || !anonKey) {
    return { text: null, generated: false, error: 'no_session' };
  }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/weekly-reflection`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: anonKey,
      },
      body: JSON.stringify({ conversationId, userId }),
    });

    const data = await res.json() as {
      text?: string;
      generated?: boolean;
      error?: string;
    };

    if (!res.ok) {
      return {
        text: null,
        generated: false,
        error: data.error ?? `http_${res.status}`,
      };
    }

    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text) {
      return { text: null, generated: false, error: 'empty_response' };
    }

    return { text, generated: Boolean(data.generated), error: null };
  } catch {
    return { text: null, generated: false, error: 'network' };
  }
}
