/**
 * Static contract: every SQL function whose name starts with admin_ is closed to the public, the signed-in people and the public key.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/adminFunctionsClosed.cases.test.ts
 *
 * Why: a function is open to everyone by default (the right goes to PUBLIC when it is created). The admin panel relies on the closed
 * functions being callable only by the service role, so a new admin_ function that forgets its REVOKE must fail here, not in production.
 * The behaviour is also checked on a real database in tests/db/adminPanel.dbtest.ts (for the functions a person could call through RPC).
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const dir = resolve("supabase/migrations");
const all = readdirSync(dir)
  .sort()
  .map((name) => readFileSync(resolve(dir, name), "utf8").replace(/^--.*$/gm, ""))
  .join("\n");

const names = new Set<string>();
for (const match of all.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(admin_[a-z0-9_]+)\s*\(/gi)) names.add(match[1]);
assert(names.size >= 11, `the admin_ functions are found (${names.size})`);

const open: string[] = [];
for (const name of names) {
  // REVOKE ALL ON FUNCTION public.<name>(<any arguments>) FROM PUBLIC ...  (anon and authenticated may follow on the same statement)
  const revoked = new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\s*\\([^)]*\\)\\s+FROM\\s+PUBLIC\\b`, "i").test(all);
  if (!revoked) open.push(name);
}
assert(open.length === 0, `admin_ functions that are not closed to PUBLIC: ${open.join(", ")}`);

// And the ones a person could name through RPC are also closed for the two browser roles explicitly.
for (const name of names) {
  const text = new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\s*\\([^)]*\\)\\s+FROM\\s+[^;]*;`, "i").exec(all)?.[0] ?? "";
  assert(/\banon\b/i.test(text) && /\bauthenticated\b/i.test(text), `${name} is revoked from anon and authenticated by name`);
}

console.log("=== adminFunctionsClosed.cases.test.ts OK ===");
