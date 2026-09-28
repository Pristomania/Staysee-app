import { setConversationCrossMemoryEnabled } from './conversationMemorySettings.ts';
import { setCrossMemoryEnabledForAll } from './profileSettings.ts';

type RpcCall = [string, Record<string, unknown>];

function recordingRpc(error: { message: string } | null = null) {
  const calls: RpcCall[] = [];
  return {
    calls,
    invoke: async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      return { error };
    },
  };
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)}`);
  }
}

const bulkRpc = recordingRpc();
assertDeepEqual(
  await setCrossMemoryEnabledForAll(false, bulkRpc.invoke),
  { ok: true },
  'bulk control succeeds',
);
assertDeepEqual(bulkRpc.calls, [[
  'set_cross_memory_enabled_for_all',
  { p_enabled: false },
]], 'bulk control calls only the account-wide RPC');

const conversationRpc = recordingRpc();
assertDeepEqual(
  await setConversationCrossMemoryEnabled(
    'conversation-1',
    true,
    conversationRpc.invoke,
  ),
  { ok: true },
  'conversation control succeeds',
);
assertDeepEqual(conversationRpc.calls, [[
  'set_conversation_cross_memory_enabled',
  { p_conversation_id: 'conversation-1', p_enabled: true },
]], 'conversation control changes only the selected conversation');

const raw = 'SUPER_SECRET_DATABASE_MESSAGE';
const failingBulkRpc = recordingRpc({ message: raw });
const failingConversationRpc = recordingRpc({ message: raw });
const originalConsoleError = console.error;
const diagnostics: string[] = [];
console.error = (...values: unknown[]) => diagnostics.push(values.join(' '));
try {
  const bulk = await setCrossMemoryEnabledForAll(true, failingBulkRpc.invoke);
  const conversation = await setConversationCrossMemoryEnabled(
    'conversation-1',
    false,
    failingConversationRpc.invoke,
  );

  assertDeepEqual(bulk, { ok: false }, 'bulk failure is closed');
  assertDeepEqual(conversation, { ok: false }, 'conversation failure is closed');
  if (JSON.stringify({ bulk, conversation, diagnostics }).includes(raw)) {
    throw new Error('backend details leaked');
  }
} finally {
  console.error = originalConsoleError;
}

console.log('memoryScopeControls.cases.test.ts — all passed');
