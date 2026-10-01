/**
 * Time-gap / current-date grounding — unit cases.
 * Run: npx tsx supabase/functions/_shared/timeGap.cases.test.ts
 */

import {
  buildCurrentDateTimePrompt,
  buildTimeGapPrompt,
  classifyTimeGap,
} from "./timeGap.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// 1. Uses the client's own local clock and timezone when both are given.
{
  const prompt = buildCurrentDateTimePrompt({
    clientNowIso: "2026-10-01T09:00:00.000Z",
    timezone: "Europe/Moscow",
    lastUserMessageAt: "2026-10-01T08:00:00.000Z",
    gapMs: 3_600_000,
    gapMinutes: 60,
  });
  assert(prompt.includes("октября 2026"), "includes the client's own date, formatted in Russian");
  assert(prompt.includes("четверг"), "Europe/Moscow pushes the date to Thursday for this UTC instant");
  console.log("✓ uses client clientNowIso + timezone");
}

// 2. Falls back to server time when no meta is provided at all (e.g. the very first
// message in a thread, where the frontend's buildClientTimeGap() returns undefined).
{
  const prompt = buildCurrentDateTimePrompt(undefined, new Date("2026-01-05T12:00:00.000Z"));
  assert(prompt.includes("января 2026"), "falls back to the supplied serverNow");
  console.log("✓ falls back to serverNow when meta is undefined");
}

// 3. Falls back to UTC formatting when meta exists but carries no timezone.
{
  const prompt = buildCurrentDateTimePrompt({
    clientNowIso: "2026-03-15T23:30:00.000Z",
    lastUserMessageAt: "2026-03-15T20:00:00.000Z",
    gapMs: 12_600_000,
    gapMinutes: 210,
  });
  assert(prompt.includes("марта 2026"), "formats clientNowIso in UTC when timezone is absent");
  console.log("✓ falls back to UTC when timezone is missing");
}

// 4. An unparseable clientNowIso must not throw and must not fabricate a date.
{
  const prompt = buildCurrentDateTimePrompt({
    clientNowIso: "not-a-real-timestamp",
    lastUserMessageAt: "2026-03-15T20:00:00.000Z",
    gapMs: 0,
    gapMinutes: 0,
  });
  assert(prompt === "", "returns empty string instead of a garbage date");
  console.log("✓ empty string for an unparseable clientNowIso");
}

// 5. Carries the internal-only framing and the false-confidence guard, every time.
{
  const prompt = buildCurrentDateTimePrompt({
    clientNowIso: "2026-06-01T10:00:00.000Z",
    lastUserMessageAt: "2026-06-01T09:00:00.000Z",
    gapMs: 3_600_000,
    gapMinutes: 60,
  });
  assert(prompt.startsWith("ВНУТРЕННЕЕ"), "marked internal, not for direct quotation");
  assert(prompt.includes("Не объявляй точную дату"), "keeps the existing never-state-exact-time convention");
  assert(prompt.includes("ложной уверенностью"), "hedges against confidently-wrong date arithmetic");
  console.log("✓ keeps the internal framing and false-confidence guard");
}

// 6. Unlike buildTimeGapPrompt, this grounding is never empty just because the gap is short.
{
  const meta = {
    clientNowIso: "2026-06-01T10:00:00.000Z",
    lastUserMessageAt: "2026-06-01T09:55:00.000Z",
    gapMs: 300_000,
    gapMinutes: 5,
  };
  assert(classifyTimeGap(meta) === "continuous", "sanity: this gap is classified continuous");
  assert(buildTimeGapPrompt(meta) === "", "sanity: continuous tier produces no pause-awareness text");
  assert(buildCurrentDateTimePrompt(meta) !== "", "date grounding is still present on every turn");
  console.log("✓ date grounding is unconditional, unlike the pause-tier prompt");
}

console.log("\nAll timeGap cases passed.");
