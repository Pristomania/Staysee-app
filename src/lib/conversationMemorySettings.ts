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

export async function setConversationCrossMemoryEnabled(
  conversationId: string,
  enabled: boolean,
  rpc: RpcInvoker = invokeSupabaseRpc,
): Promise<{ ok: boolean }> {
  const { error } = await rpc('set_conversation_cross_memory_enabled', {
    p_conversation_id: conversationId,
    p_enabled: enabled,
  });

  if (error) {
    console.error('[conversation] cross-memory update failed');
    return { ok: false };
  }
  return { ok: true };
}
