// When the input box goes over the 10,000-character maximum, the app tells the database how long the text
// was (the length only, never the text). The box does not send such a text, so this is the only trace of it,
// and over the months it shows whether people need a longer limit.

type RpcInvoker = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ error: unknown }>;

async function invokeSupabaseRpc(
  name: string,
  args: Record<string, unknown>,
): Promise<{ error: unknown }> {
  const { supabase } = await import('./supabase');
  const { error } = await supabase.rpc(name, args);
  return { error };
}

/** One report each time the text goes over the maximum, not on every key press while it stays over. */
export function shouldReportOverLimit(wasTooLong: boolean, isTooLong: boolean): boolean {
  return !wasTooLong && isTooLong;
}

/** Never throws and never reaches the person: a lost report is only a lost data point. */
export async function reportOverLimit(
  charCount: number,
  rpc: RpcInvoker = invokeSupabaseRpc,
): Promise<void> {
  try {
    await rpc('record_over_limit_hit', { p_char_count: charCount });
  } catch {
    // Nothing to do: the report is best effort.
  }
}
