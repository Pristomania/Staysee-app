/**
 * Staging E2E for fact evolution v1 (write path + injection read path).
 * Run: npx tsx supabase/functions/_shared/factEvolution.staging-e2e.ts
 */
import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { buildCrossMemoryCandidates } from "./crossMemoryBuild.ts";
import { filterCrossMemoryCandidates, filterCrossMemoryRowsForInjection } from "./crossMemoryPolicy.ts";
import { evolveMemoryFacts, type ExistingFactRow } from "./factEvolution.ts";

const STAGING_REF = "hdmoetcvlszrdukqpiia";
const STAGING_URL = `https://${STAGING_REF}.supabase.co`;
const TEST_USER = "12c823c1-a82b-408c-8179-bc02e8d7e3b1";
const TAG = "__TEST__ fact evolution v1";

function getServiceKey(): string {
  const raw = execSync(
    `npx supabase projects api-keys --project-ref ${STAGING_REF} -o json`,
    { encoding: "utf8" }
  );
  const keys = JSON.parse(raw) as Array<{ name: string; api_key: string }>;
  const key = keys.find((k) => k.name === "service_role")?.api_key;
  if (!key) throw new Error("service_role key missing");
  return key;
}

async function applyCandidates(
  admin: ReturnType<typeof createClient>,
  tracked: ExistingFactRow[],
  people: string[]
): Promise<ExistingFactRow[]> {
  const memory = { people, preferences: [] as string[] };
  const candidates = filterCrossMemoryCandidates(buildCrossMemoryCandidates(memory));
  let rows = [...tracked];

  for (const c of candidates) {
    const evolution = evolveMemoryFacts(rows, c);
    if (!evolution || evolution.action === "ignore") continue;
    if (evolution.action !== "add" && evolution.action !== "enrich" && evolution.action !== "replace") {
      continue;
    }

    for (const id of evolution.deleteRowIds ?? []) {
      await admin.from("user_memory").delete().eq("id", id);
      rows = rows.filter((r) => r.id !== id);
    }

    const { data, error } = await admin
      .from("user_memory")
      .insert({
        user_id: TEST_USER,
        memory_type: evolution.memory_type,
        content: evolution.content.endsWith(".") ? evolution.content : `${evolution.content}.`,
      })
      .select("id, content, memory_type")
      .single();

    if (error) throw new Error(`insert: ${error.message}`);
    rows.push({
      id: data.id as string,
      content: data.content as string,
      memory_type: data.memory_type as string,
    });
  }

  return rows;
}

function sonRows(rows: ExistingFactRow[]): string[] {
  return rows
    .filter((r) => r.memory_type === "life_context" && /сын/i.test(r.content))
    .map((r) => r.content.replace(/[.!?…]+$/u, ""));
}

function partnerRows(rows: ExistingFactRow[]): string[] {
  return rows
    .filter((r) => r.memory_type === "life_context" && /партн|вместе/i.test(r.content))
    .map((r) => r.content.replace(/[.!?…]+$/u, ""));
}

function petRows(rows: ExistingFactRow[]): string[] {
  return rows
    .filter((r) => r.memory_type === "life_context" && /собак/i.test(r.content))
    .map((r) => r.content.replace(/[.!?…]+$/u, ""));
}

async function main(): Promise<void> {
  const admin = createClient(STAGING_URL, getServiceKey());
  const report: Record<string, unknown> = {};
  const cleanupIds: string[] = [];

  const { data: oldRows } = await admin
    .from("user_memory")
    .select("id, content")
    .eq("user_id", TEST_USER)
    .or("content.ilike.%сын%,content.ilike.%партн%,content.ilike.%собак%");
  for (const r of oldRows ?? []) cleanupIds.push(r.id);

  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .insert({ user_id: TEST_USER, title: TAG })
    .select("id")
    .single();
  if (convErr) throw new Error(convErr.message);

  let tracked: ExistingFactRow[] = [];

  tracked = await applyCandidates(admin, tracked, ["У меня есть сын"]);
  report.sonStep1 = sonRows(tracked);
  tracked = await applyCandidates(admin, tracked, ["Сыну 18"]);
  report.sonStep2 = sonRows(tracked);
  tracked = await applyCandidates(admin, tracked, ["Сын живёт со мной"]);
  report.sonStep3 = sonRows(tracked);
  tracked = await applyCandidates(admin, tracked, ["Сын ушёл в армию"]);
  report.sonStep4 = sonRows(tracked);

  const { data: injectAfterArmy } = await admin
    .from("user_memory")
    .select("memory_type, content")
    .eq("user_id", TEST_USER)
    .ilike("content", "%сын%");
  report.sonInjection = filterCrossMemoryRowsForInjection(injectAfterArmy ?? []).map((r) =>
    r.content.replace(/[.!?…]+$/u, "")
  );

  for (const id of tracked.map((r) => r.id).filter(Boolean) as string[]) cleanupIds.push(id);

  tracked = [];
  tracked = await applyCandidates(admin, tracked, ["партнёр не живёт вместе"]);
  report.partnerSoftBefore = partnerRows(tracked);
  tracked = await applyCandidates(admin, tracked, ["партнёр часто остаётся на ночь"]);
  report.partnerSoftAfter = partnerRows(tracked);
  for (const id of tracked.map((r) => r.id).filter(Boolean) as string[]) cleanupIds.push(id);

  tracked = [];
  tracked = await applyCandidates(admin, tracked, ["партнёр не живёт вместе"]);
  tracked = await applyCandidates(admin, tracked, ["живём вместе с партнёром"]);
  report.partnerTogether = partnerRows(tracked);
  for (const id of tracked.map((r) => r.id).filter(Boolean) as string[]) cleanupIds.push(id);

  tracked = [];
  tracked = await applyCandidates(admin, tracked, ["У меня есть собака"]);
  report.petStep1 = petRows(tracked);
  tracked = await applyCandidates(admin, tracked, ["Собаку зовут Крис"]);
  report.petStep2 = petRows(tracked);
  for (const id of tracked.map((r) => r.id).filter(Boolean) as string[]) cleanupIds.push(id);

  const amb = evolveMemoryFacts([], {
    memory_type: "life_context",
    content: "он стал часто ночевать",
  });
  report.ambiguousPronoun = amb;

  for (const id of [...new Set(cleanupIds)]) {
    await admin.from("user_memory").delete().eq("id", id);
  }
  await admin.from("conversations").delete().eq("id", conv.id);

  const pass =
    JSON.stringify(report.sonStep1).includes("сын") &&
    JSON.stringify(report.sonStep2).includes("18") &&
    JSON.stringify(report.sonStep3).includes("живёт со мной") &&
    JSON.stringify(report.sonStep4).includes("армии") &&
    !JSON.stringify(report.sonStep4).includes("живёт со мной") &&
    (report.sonInjection as string[]).length === 1 &&
    (report.partnerSoftAfter as string[]).some((s) => /ночь/i.test(s)) &&
    !(report.partnerSoftAfter as string[]).some((s) => /не живёт вместе/i.test(s)) &&
    (report.partnerTogether as string[]).some((s) => /живём вместе/i.test(s)) &&
    (report.petStep2 as string[]).some((s) => /Крис/i.test(s)) &&
    (report.ambiguousPronoun as { action?: string })?.action === "ignore";

  console.log(JSON.stringify({ pass, report }, null, 2));
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
