/**
 * Prod REST guard — blocks profiles?limit=1 fallback on production.
 * Run: node scripts/lib/prod-test-env.cases.mjs
 */

import { guardProdRestPath, assertExplicitTestUserId } from "./prod-test-env.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

const prod = "https://jnxrildlwvtxhtiwucbt.supabase.co";
const staging = "https://hdmoetcvlszrdukqpiia.supabase.co";

guardProdRestPath(staging, "profiles?select=id&limit=1");
guardProdRestPath(prod, "profiles?id=eq.0236ced5-b379-40de-a9a3-16f2caff280d&select=id");

assertThrows(
  () => guardProdRestPath(prod, "profiles?select=id&limit=1"),
  "prod profiles?limit=1 must throw"
);

assert(
  assertExplicitTestUserId("0236ced5-b379-40de-a9a3-16f2caff280d") ===
    "0236ced5-b379-40de-a9a3-16f2caff280d",
  "valid test user id accepted"
);

assertThrows(() => assertExplicitTestUserId(""), "empty test user id rejected");
assertThrows(() => assertExplicitTestUserId("not-a-uuid"), "invalid uuid rejected");

console.log("prod-test-env.cases.mjs — all passed");
