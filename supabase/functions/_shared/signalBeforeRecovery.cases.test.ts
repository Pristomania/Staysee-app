/**
 * Run: npx tsx supabase/functions/_shared/signalBeforeRecovery.cases.test.ts
 * A hidden signal tag at the end of a good answer made the answer look cut off, and the completeness check then shortened it to
 * its first sentence (found 20.11.2026 on the crisis and attack answers, which are the ones that carry a tag). The tag is taken off
 * before the check.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isPublishableReply } from "./completeReply.ts";
import { parseAndStripProtocolSignals } from "./protocolSignalParser.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const answer = "Я не могу поставить тебе диагноз. Но твои слова об угрозе себе я воспринимаю всерьёз.\n\nТы сейчас в безопасности?";
const withTag = `${answer}\n[STAYSEE_SIGNAL: crisis_detected]`;

// The mechanism of the bug: with the tag the whole answer is "not publishable", without it it is.
assert(!isPublishableReply(withTag), "with the tag at the end the answer does not look complete (this is why it was cut)");
const split = parseAndStripProtocolSignals(withTag);
assert(isPublishableReply(split.text) && split.text === answer, "without the tag the same answer is complete and whole");
assert(split.signals.includes("crisis_detected"), "the signal is still read, for the log");

// The wiring: the tag is taken off before the recovery, and its signals reach the log.
const chat = readFileSync(resolve("supabase/functions/staysee-chat/index.ts"), "utf8").replace(/\r/g, "");
const strip = chat.indexOf("const firstSegmentSplit = parseAndStripProtocolSignals(result.content?.trim() ?? \"\");");
const recovery = chat.indexOf("const recovery = await runReplyRecoveryRoutes({");
assert(strip > 0 && recovery > strip, "the tags are taken off before the recovery routes run");
assert(/const firstSegmentContent = firstSegmentSplit\.text;/.test(chat), "the recovery gets the text without the tags");
assert(/new Set\(\[\.\.\.firstSegmentSplit\.signals, \.\.\.signalParse\.signals\]\)/.test(chat), "the signals of the first segment reach the log");

console.log("All signalBeforeRecovery cases passed.");
