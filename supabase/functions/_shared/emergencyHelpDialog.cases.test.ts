/**
 * Run: npx tsx supabase/functions/_shared/emergencyHelpDialog.cases.test.ts
 * The emergency help window must be measured from the screen, not from the top row of the chat (that row has a blurred background,
 * and inside such a block "fixed" is measured from the block: the window slipped out of the top of the screen, seen 20.11.2026).
 * Read from the source (the browser is not here).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const source = readFileSync(resolve("src/components/EmergencyHelpButton.tsx"), "utf8").replace(/\r/g, "");
assert(/import \{ createPortal \} from 'react-dom';/.test(source), "the window is drawn through a portal");
assert(/createPortal\(\s*<div[\s\S]*?document\.body,\s*\)/.test(source), "into the body of the page, outside the top row");
assert(/fixed inset-0 z-\[100\]/.test(source), "over everything, from the screen");
assert(/max-h-full overflow-y-auto/.test(source), "and it scrolls inside the screen when the screen is low");

const chat = readFileSync(resolve("src/components/screens/ChatScreen.tsx"), "utf8").replace(/\r/g, "");
assert(/backdropFilter: 'blur\(12px\)'/.test(chat) && /<EmergencyHelpButton \/>/.test(chat), "the button still sits in the blurred top row, which is why the portal is needed");

console.log("All emergencyHelpDialog cases passed.");
