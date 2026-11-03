/**
 * Run: npx tsx supabase/functions/_shared/memoryScreenAfterDelete.cases.test.ts
 * After "delete all memory" on the memory screen of a plan without memory between conversations, the counters on the
 * screen ("Эта беседа · 7") must drop to zero at once, not only after a page refresh (seen in the live journey,
 * 03.11.2026). Read from the source, because the screens need a browser.
 */

import { readFileSync } from 'node:fs';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const panels = readFileSync(new URL('../../../src/components/LockedPanels.tsx', import.meta.url), 'utf8');
const screen = readFileSync(new URL('../../../src/components/screens/MemoryScreen.tsx', import.meta.url), 'utf8');

// The panel tells its screen when the memory is gone, and only when the deletion went through.
assert(/onMemoryDeleted/.test(panels), 'the locked memory panel takes a callback for "memory deleted"');
assert(/if \(done\) onMemoryDeleted\?\.\(\)/.test(panels) || /if \(ok\) onMemoryDeleted\?\.\(\)/.test(panels), 'the callback runs only after a successful deletion');

// The screen empties both lists it counts from.
const start = screen.indexOf('<LockedMemoryPanel');
assert(start >= 0, 'the memory screen shows the locked panel');
const tag = screen.slice(start, screen.indexOf('/>', start));
assert(tag.includes('onMemoryDeleted='), 'the memory screen passes the callback to the locked panel');
assert(tag.includes('setMemoryV3Dialogue([])') && tag.includes('setMemoryV3AccountWide([])'), 'the callback empties the conversation list and the "about me" list');

console.log('All memoryScreenAfterDelete cases passed.');
