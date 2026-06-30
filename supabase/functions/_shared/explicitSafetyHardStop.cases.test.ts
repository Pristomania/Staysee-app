/**
 * PR7a explicit crisis hard-stop tests.
 * Run: npx tsx supabase/functions/_shared/explicitSafetyHardStop.cases.test.ts
 */

import { detectExplicitSafetyHardStop } from "./explicitSafetyHardStop.ts";

let failed = 0;

function assertStop(msg: string, expect: boolean) {
  const r = detectExplicitSafetyHardStop(msg);
  const ok = r.shouldStop === expect;
  if (!ok) {
    console.log(`FAIL [${expect ? "STOP" : "NO"}]: ${JSON.stringify(msg)} got=${r.shouldStop}`);
    failed++;
  } else {
    console.log(`PASS [${expect ? "STOP" : "NO"}]: ${msg.slice(0, 50)}`);
  }
}

console.log("=== explicitSafetyHardStop positives ===\n");
for (const msg of [
  "я хочу умереть",
  "я собираюсь умереть",
  "я хочу покончить с собой",
  "я собираюсь покончить с собой",
  "я убью себя",
  "я хочу причинить себе вред",
  "я сейчас причиню себе вред",
  "я собираюсь причинить себе вред",
]) {
  assertStop(msg, true);
}

console.log("\n=== explicitSafetyHardStop negatives ===\n");
for (const msg of [
  "Продолжать",
  "продолжай",
  "дальше",
  "не знаю",
  "пусто",
  "не могу",
  "устала",
  "нет смысла",
  "больше не могу",
  "у меня есть план",
  "у меня есть план, как это сделать",
  "у меня есть способ",
  "я знаю как это сделать",
  "я решила",
  "сегодня сделаю",
  "незачем продолжать проект",
  "нет смысла вести соцсети",
  "у меня умер дедушка",
  "я боюсь умереть",
  "таблетки мне назначил врач",
  "план проекта развалился",
]) {
  assertStop(msg, false);
}

console.log(`\n=== ${failed === 0 ? "All passed" : `${failed} failed`} ===`);
if (failed > 0) process.exit(1);
