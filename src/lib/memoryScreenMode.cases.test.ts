import {
  isLegacyMemoryCompatibilityEnabled,
  resolveMemoryScreenCapabilities,
} from './memoryScreenMode.ts';

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)}`);
  }
}

assertDeepEqual(resolveMemoryScreenCapabilities('profile'), {
  canChooseConversation: true,
  showAccountWideMemory: true,
  showProfileBulkControl: true,
  showConversationControl: false,
}, 'profile mode capabilities');

assertDeepEqual(resolveMemoryScreenCapabilities('chat'), {
  canChooseConversation: false,
  showAccountWideMemory: false,
  showProfileBulkControl: false,
  showConversationControl: true,
}, 'chat mode capabilities');

assertDeepEqual(
  isLegacyMemoryCompatibilityEnabled({ legacy_memory_compat_enabled: true }),
  true,
  'explicit compatibility flag enables the legacy comparison',
);
assertDeepEqual(
  isLegacyMemoryCompatibilityEnabled({ legacy_memory_compat_enabled: false }),
  false,
  'explicit false keeps the Memory V3-only interface',
);
assertDeepEqual(
  isLegacyMemoryCompatibilityEnabled(null),
  false,
  'missing profile fails closed to Memory V3-only',
);

console.log('memoryScreenMode.cases.test.ts — all passed');
