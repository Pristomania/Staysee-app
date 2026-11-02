// Puts the technical test user (and nobody else) on the free or the premium plan, for a check in the browser or by hand.
//
//   STAYSEE_ALLOW_PROD_TESTS=1 STAYSEE_TEST_USER_ID=<the technical user> node scripts/set-technical-plan.mjs free
//   STAYSEE_ALLOW_PROD_TESTS=1 STAYSEE_TEST_USER_ID=<the technical user> node scripts/set-technical-plan.mjs free --used=41
//   STAYSEE_ALLOW_PROD_TESTS=1 STAYSEE_TEST_USER_ID=<the technical user> node scripts/set-technical-plan.mjs premium
//   ... free --used=50 --pack      (free, all 50 used, and one pack of 100 bought messages added)
//
// "free" is the real free plan: a fresh count of 50 messages, one conversation, no unlimited mark, so that the closed
// doors can be seen. "--used=N" (free only, 0 to 50) sets how many of the 50 are already used, so that the counter, the
// warning from ten messages left and the end of the messages can be looked at without spending real messages.
// "--pack" (any plan) adds one pack of bought messages (migration 090) so that the counter and the spending order can be
// looked at. Every run first voids the technical user's open packs, so the state is always exactly what was asked.
// "premium" is the normal state of the technical user: premium, unlimited, 50 conversations.
// ALWAYS go back to premium when the check is done.
//
// It refuses any account whose address does not end in .invalid (the technical accounts), so a real person's plan cannot be
// changed with it by a wrong id. The changes go through the database functions set_user_plan and set_unlimited_usage
// (migration 089), which start a fresh period.
import { assertProdTestAllowed, makeServiceHeaders, restJson } from "./lib/prod-test-env.mjs";

async function main() {
  const plan = process.argv[2];
  if (!["free", "premium"].includes(plan)) {
    console.error("Usage: node scripts/set-technical-plan.mjs free|premium [--used=N (free only, 0 to 50)] [--pack]");
    process.exitCode = 1;
    return;
  }

  // The count of used messages (free only), checked before anything is written.
  const usedArg = process.argv.slice(3).find((arg) => arg.startsWith("--used="));
  let used;
  if (usedArg !== undefined) {
    used = Number(usedArg.slice("--used=".length));
    if (plan !== "free" || !(Number.isInteger(used) && used >= 0 && used <= 50)) {
      console.error("--used=N is only for the free plan and must be a whole number from 0 to 50. Nothing was changed.");
      process.exitCode = 1;
      return;
    }
  }

  const wantPack = process.argv.slice(3).includes("--pack");

  const { url, serviceKey, testUserId } = assertProdTestAllowed();
  const headers = makeServiceHeaders(serviceKey);

  const account = await fetch(`${url}/auth/v1/admin/users/${testUserId}`, { headers });
  const user = await account.json().catch(() => ({}));
  if (!account.ok || !/@[^@]+\.invalid$/i.test(user.email ?? "")) {
    console.error("refusing: this account is not a technical one (its address must end in .invalid). Nothing was changed.");
    process.exitCode = 1;
    return;
  }

  const rpc = (name, body) => restJson(url, headers, `rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
  await rpc("set_user_plan", { p_user_id: testUserId, p_tier: plan });
  await rpc("set_unlimited_usage", { p_user_id: testUserId, p_on: plan === "premium" });
  await restJson(url, headers, `user_usage_tiers?user_id=eq.${testUserId}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({
      max_conversations_override: plan === "premium" ? 50 : null,
      ...(used !== undefined ? { period_requests_used: used } : {}),
    }),
  });

  // The technical user's packs are test packs: none left over from before, one new if asked.
  try {
    const open = (await restJson(url, headers, `message_packs?user_id=eq.${testUserId}&voided_at=is.null&messages_left=gt.0&select=id`)) ?? [];
    for (const pack of open) await rpc("void_message_pack", { p_pack_id: pack.id });
    if (wantPack) await rpc("grant_message_pack", { p_user_id: testUserId, p_messages: 100, p_payment_ref: `technical-test-${Date.now()}` });
  } catch (error) {
    // An older database has no packs table yet: that alone is not an error unless a pack was asked for. Anything else
    // (a refused call, a broken connection) must not be passed over: the state would not be what was asked.
    const noPacksTable = /PGRST205|message_packs/i.test(String(error?.message)) && /404|does not exist|schema cache/i.test(String(error?.message));
    if (wantPack || !noPacksTable) throw error;
  }

  const row = (await restJson(url, headers, `user_usage_tiers?user_id=eq.${testUserId}&select=tier,unlimited_usage,max_conversations_override,period_requests_used`))?.[0];
  console.log(`technical user is now: ${JSON.stringify(row)}`);
}

await main();
