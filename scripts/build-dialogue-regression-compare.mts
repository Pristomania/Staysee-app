/**
 * Merge two live dialogue-regression reports into side-by-side compare MD+JSON.
 *
 * Usage:
 *   npx tsx scripts/build-dialogue-regression-compare.mts \
 *     --current scripts/_tmp-dialogue-regression-report-<stamp>.json \
 *     --candidate scripts/_tmp-dialogue-regression-report-<stamp>.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

type AutoFlags = Record<string, boolean>;

type Turn = {
  turn_index: number;
  user: string;
  expectations?: Record<string, string[]>;
  answer: string | null;
  conversation_id?: string | null;
  request_id?: string | null;
  prompt_version?: string | null;
  model?: string | null;
  finish_reason?: string | null;
  completion_tokens?: number | null;
  protocol_events?: Array<Record<string, unknown>>;
  auto_flags: AutoFlags;
  auto_fail_reasons: string[];
  human_review_needed: boolean;
  continuity?: {
    continuity_valid?: boolean;
    before_turn_db_message_count?: number;
    after_turn_db_message_count?: number;
    before_user_count?: number;
    before_assistant_count?: number;
    after_user_count?: number;
    after_assistant_count?: number;
    assistant_saved?: boolean;
    user_saved?: boolean;
    invalid_reasons?: string[];
  };
};

type Case = {
  case_id: string;
  title: string;
  type: string;
  review_mode: string;
  conversation_id?: string | null;
  all_turns_same_conversation_id?: boolean;
  turn_count?: number;
  continuity_valid?: boolean;
  invalid_multiturn?: boolean;
  invalid_reasons?: string[];
  turns: Turn[];
  human_review_needed: boolean;
  auto_fail: boolean;
  auto_fail_reasons: string[];
};

type Report = {
  mode: string;
  target: string;
  doc: string;
  expected_prompt_version?: string;
  timestamp: string;
  stamp: number;
  cases: Case[];
  summary?: Record<string, unknown>;
};

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const current = get("--current");
  const candidate = get("--candidate");
  if (!current || !candidate) {
    throw new Error("Need --current <path> and --candidate <path>");
  }
  return {
    current: resolve(ROOT, current),
    candidate: resolve(ROOT, candidate),
  };
}

function loadReport(path: string): Report {
  return JSON.parse(readFileSync(path, "utf8")) as Report;
}

function raisedFlags(flags: AutoFlags | undefined): string[] {
  if (!flags) return [];
  return Object.entries(flags)
    .filter(([, v]) => v)
    .map(([k]) => k);
}

function safetyVerdict(c: Case | undefined): string {
  if (!c) return "MISSING";
  if (c.review_mode !== "safety_invariant") return "n/a";
  if (c.auto_fail) return "FAIL";
  const soft = c.turns.some((t) => raisedFlags(t.auto_flags).length > 0);
  return soft ? "WATCH" : "PASS";
}

function protocolSummary(events: Array<Record<string, unknown>> | undefined): string {
  if (!events?.length) return "[]";
  return events
    .map((e) => String(e.event_type ?? e.reason ?? JSON.stringify(e)))
    .join(", ");
}

function metaLine(t: Turn | undefined): string {
  if (!t) return "missing";
  return [
    `request_id=${t.request_id ?? "—"}`,
    `prompt_version=${t.prompt_version ?? "—"}`,
    `model=${t.model ?? "—"}`,
    `tokens=${t.completion_tokens ?? "—"}`,
    `finish_reason=${t.finish_reason ?? "—"}`,
    `protocol_events=${protocolSummary(t.protocol_events)}`,
  ].join(", ");
}

function renderCompare(current: Report, candidate: Report, stamp: number): string {
  const lines: string[] = [];
  lines.push(`# StaySee Dialogue Regression Compare`);
  lines.push(`target: staging`);
  lines.push(`current: staysee-core-v2-gpts-source`);
  lines.push(`candidate: staysee-legacy-doc-flat-clean`);
  lines.push(`timestamp: ${new Date(stamp).toISOString()}`);
  lines.push(`current_run: ${current.timestamp} (doc=${current.doc})`);
  lines.push(`candidate_run: ${candidate.timestamp} (doc=${candidate.doc})`);
  lines.push("");
  lines.push(
    `This is REAL MULTI-TURN run with DB continuity verification.`,
  );
  lines.push(
    `Старый compare 1784939583193 сохранён как isolated-turn/no-confirmed-memory comparison (runner then did not persist messages; staysee-chat history was empty each turn).`,
  );
  lines.push("");
  lines.push(`## Verification`);
  lines.push("");
  lines.push(`- current prompt_versions: ${JSON.stringify(current.summary?.prompt_versions ?? [])}`);
  lines.push(`- candidate prompt_versions: ${JSON.stringify(candidate.summary?.prompt_versions ?? [])}`);
  lines.push(`- current models: ${JSON.stringify(current.summary?.models ?? [])}`);
  lines.push(`- candidate models: ${JSON.stringify(candidate.summary?.models ?? [])}`);
  lines.push(
    `- current sonnet_depth_routing_seen: ${String(current.summary?.sonnet_depth_routing_seen ?? "—")}`,
  );
  lines.push(
    `- candidate sonnet_depth_routing_seen: ${String(candidate.summary?.sonnet_depth_routing_seen ?? "—")}`,
  );
  lines.push(
    `- current continuity_valid_cases: ${JSON.stringify(current.summary?.continuity_valid_cases ?? [])}`,
  );
  lines.push(
    `- candidate continuity_valid_cases: ${JSON.stringify(candidate.summary?.continuity_valid_cases ?? [])}`,
  );
  lines.push(
    `- current invalid_multiturn_cases: ${JSON.stringify(current.summary?.invalid_multiturn_cases ?? [])}`,
  );
  lines.push(
    `- candidate invalid_multiturn_cases: ${JSON.stringify(candidate.summary?.invalid_multiturn_cases ?? [])}`,
  );
  lines.push("");
  lines.push(
    `Ordinary cases: human reading only (моя / сомневаюсь / не моя). No automatic voice winner.`,
  );
  lines.push("");

  const byId = (cases: Case[]) => Object.fromEntries(cases.map((c) => [c.case_id, c]));
  const curMap = byId(current.cases);
  const candMap = byId(candidate.cases);
  const ids = [
    ...new Set([...current.cases.map((c) => c.case_id), ...candidate.cases.map((c) => c.case_id)]),
  ];

  for (const id of ids) {
    const cur = curMap[id];
    const cand = candMap[id];
    const title = cur?.title ?? cand?.title ?? id;
    const type = cur?.type ?? cand?.type ?? "";
    const review = cur?.review_mode ?? cand?.review_mode ?? "";
    const invalid =
      cur?.invalid_multiturn === true || cand?.invalid_multiturn === true;
    lines.push(`---`);
    lines.push("");
    lines.push(`## Case: ${id} — ${title}`);
    lines.push("");
    if (invalid) {
      lines.push(`**INVALID_MULTITURN** — do not treat this case as a confirmed multi-turn voice sample.`);
      lines.push("");
    }
    lines.push(`- type: ${type}`);
    lines.push(`- review_mode: ${review}`);
    lines.push(`- human_review_needed: true`);
    lines.push(
      `- current continuity_valid: ${String(cur?.continuity_valid ?? "—")} | conversation_id: ${cur?.conversation_id ?? "—"}`,
    );
    lines.push(
      `- candidate continuity_valid: ${String(cand?.continuity_valid ?? "—")} | conversation_id: ${cand?.conversation_id ?? "—"}`,
    );
    if (cur?.invalid_reasons?.length) {
      lines.push(`- current invalid_reasons: ${cur.invalid_reasons.join("; ")}`);
    }
    if (cand?.invalid_reasons?.length) {
      lines.push(`- candidate invalid_reasons: ${cand.invalid_reasons.join("; ")}`);
    }
    if (review === "safety_invariant") {
      lines.push(`- safety auto current: ${safetyVerdict(cur)}`);
      lines.push(`- safety auto candidate: ${safetyVerdict(cand)}`);
      if (cur?.auto_fail_reasons?.length) {
        lines.push(`- current auto_fail_reasons: ${cur.auto_fail_reasons.join("; ")}`);
      }
      if (cand?.auto_fail_reasons?.length) {
        lines.push(`- candidate auto_fail_reasons: ${cand.auto_fail_reasons.join("; ")}`);
      }
    }
    lines.push("");

    const turnCount = Math.max(cur?.turns.length ?? 0, cand?.turns.length ?? 0);
    for (let i = 0; i < turnCount; i++) {
      const ct = cur?.turns[i];
      const lt = cand?.turns[i];
      const user = ct?.user ?? lt?.user ?? "";
      lines.push(`### Turn ${i + 1}`);
      lines.push("");
      lines.push(`**User:**`);
      lines.push("");
      lines.push(user);
      lines.push("");
      lines.push(`### Current v2`);
      lines.push("");
      lines.push(ct?.answer ?? "_(missing)_");
      lines.push("");
      lines.push(`### Legacy clean`);
      lines.push("");
      lines.push(lt?.answer ?? "_(missing)_");
      lines.push("");
      lines.push(`**Metadata:**`);
      lines.push(`- current: ${metaLine(ct)}`);
      lines.push(`- legacy: ${metaLine(lt)}`);
      if (ct?.continuity || lt?.continuity) {
        lines.push(`**Continuity:**`);
        if (ct?.continuity) {
          const x = ct.continuity;
          lines.push(
            `- current: valid=${x.continuity_valid} before=${x.before_turn_db_message_count} after=${x.after_turn_db_message_count} user ${x.before_user_count}->${x.after_user_count} assistant ${x.before_assistant_count}->${x.after_assistant_count} saved u/a=${x.user_saved}/${x.assistant_saved}`,
          );
        }
        if (lt?.continuity) {
          const x = lt.continuity;
          lines.push(
            `- legacy: valid=${x.continuity_valid} before=${x.before_turn_db_message_count} after=${x.after_turn_db_message_count} user ${x.before_user_count}->${x.after_user_count} assistant ${x.before_assistant_count}->${x.after_assistant_count} saved u/a=${x.user_saved}/${x.assistant_saved}`,
          );
        }
      }
      lines.push("");
      lines.push(`**Auto flags:**`);
      lines.push(
        `- current: ${raisedFlags(ct?.auto_flags).join(", ") || "(none)"}`,
      );
      lines.push(
        `- legacy: ${raisedFlags(lt?.auto_flags).join(", ") || "(none)"}`,
      );
      lines.push("");
      lines.push(`**Human review:**`);
      lines.push(`- [ ] current лучше`);
      lines.push(`- [ ] legacy лучше`);
      lines.push(`- [ ] оба ок`);
      lines.push(`- [ ] оба не то`);
      lines.push(`- [ ] нужна правка кейса/ожидания`);
      lines.push(`Comment:`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const current = loadReport(args.current);
  const candidate = loadReport(args.candidate);
  const stamp = Date.now();

  const compare = {
    mode: "side-by-side-compare-multiturn",
    target: "staging",
    current_label: "staysee-core-v2-gpts-source",
    candidate_label: "staysee-legacy-doc-flat-clean",
    timestamp: new Date(stamp).toISOString(),
    stamp,
    real_multiturn_with_db_continuity: true,
    prior_isolated_compare_preserved:
      "scripts/_tmp-dialogue-regression-compare-1784939583193.md",
    current_source: args.current,
    candidate_source: args.candidate,
    current_summary: current.summary ?? null,
    candidate_summary: candidate.summary ?? null,
    all_continuity_valid:
      current.summary?.all_continuity_valid === true &&
      candidate.summary?.all_continuity_valid === true,
    cases: (() => {
      const curMap = Object.fromEntries(current.cases.map((c) => [c.case_id, c]));
      const candMap = Object.fromEntries(candidate.cases.map((c) => [c.case_id, c]));
      const ids = [
        ...new Set([
          ...current.cases.map((c) => c.case_id),
          ...candidate.cases.map((c) => c.case_id),
        ]),
      ];
      return ids.map((id) => {
        const cur = curMap[id];
        const cand = candMap[id];
        const turnCount = Math.max(cur?.turns.length ?? 0, cand?.turns.length ?? 0);
        return {
          case_id: id,
          title: cur?.title ?? cand?.title,
          type: cur?.type ?? cand?.type,
          review_mode: cur?.review_mode ?? cand?.review_mode,
          human_review_needed: true,
          invalid_multiturn:
            cur?.invalid_multiturn === true || cand?.invalid_multiturn === true,
          continuity_valid_current: cur?.continuity_valid ?? null,
          continuity_valid_candidate: cand?.continuity_valid ?? null,
          conversation_id_current: cur?.conversation_id ?? null,
          conversation_id_candidate: cand?.conversation_id ?? null,
          safety_auto_current: safetyVerdict(cur),
          safety_auto_candidate: safetyVerdict(cand),
          turns: Array.from({ length: turnCount }, (_, i) => ({
            turn_index: i + 1,
            user: cur?.turns[i]?.user ?? cand?.turns[i]?.user ?? "",
            current: cur?.turns[i] ?? null,
            candidate: cand?.turns[i] ?? null,
          })),
        };
      });
    })(),
  };

  const mdPath = resolve(ROOT, `scripts/_tmp-dialogue-regression-compare-${stamp}.md`);
  const jsonPath = resolve(ROOT, `scripts/_tmp-dialogue-regression-compare-${stamp}.json`);
  writeFileSync(mdPath, renderCompare(current, candidate, stamp), "utf8");
  writeFileSync(jsonPath, JSON.stringify(compare, null, 2), "utf8");
  console.log(`md: ${mdPath}`);
  console.log(`json: ${jsonPath}`);
}

main();
