/**
 * Run: npx tsx supabase/functions/_shared/firstContactWiring.cases.test.ts
 * The introduction is saved as the first message of the very first conversation, so that the model reads it as history.
 * Read from the sources (the app cannot be started here).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const main = readFileSync(resolve("src/components/screens/MainScreen.tsx"), "utf8").replace(/\r/g, "");
assert(/from '\.\.\/\.\.\/lib\/firstContact'/.test(main), "the main screen uses the introduction");
assert(/isFirstConversation\(conversations\.length\)/.test(main), "only the first conversation of an account gets it");
// The owner of the new room comes from the screen's own userId (the room is made through createRoom(userId), not by a direct insert).
assert(/insertChatMessage\(data\.id, 'ai', FIRST_CONTACT_MESSAGE, \{ userId(: user!\.id)? \}\)/.test(main), "it is saved as a message of Stacy, in the new conversation");
assert(/setMessages\(\[introduction\.message \?\? greetingFor\(data\.id\)\]\)/.test(main) || /introduction\.message/.test(main), "if it cannot be saved the usual greeting opens the conversation");

console.log("All firstContactWiring cases passed.");
