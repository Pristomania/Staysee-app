import { resolveMemoryScreenCapabilities } from './memoryScreenMode.ts';

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

console.log('memoryScreenMode.cases.test.ts — all passed');
