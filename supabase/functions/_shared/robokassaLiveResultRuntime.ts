import { createClient } from "npm:@supabase/supabase-js@2.107.0";
import {
  createRobokassaLiveResult,
  type LiveResultConfig,
  validLiveResultConfig,
} from "./robokassaLiveResult.ts";
import {
  createLiveResultStore,
  type LiveResultDatabase,
} from "./robokassaLiveResultStore.ts";

/** Server callback only. No checkout, no password1, no test-credential fallback. */
export function serveRobokassaLiveResult(): void {
  const config: LiveResultConfig = {
    enabled: Deno.env.get("ROBOKASSA_LIVE_RESULT_ENABLED") === "1",
    merchantLogin: Deno.env.get("ROBOKASSA_LIVE_MERCHANT_LOGIN") ?? "",
    password2: Deno.env.get("ROBOKASSA_LIVE_PASSWORD_2") ?? "",
    testPasswords: ["ROBOKASSA_TEST_PASSWORD_1", "ROBOKASSA_TEST_PASSWORD_2"]
      .map((name) => Deno.env.get(name) ?? "").filter(Boolean),
  };
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Independent of create_enabled: closing new checkouts cannot discard money already paid.
  if (!validLiveResultConfig(config) || !url || !key) {
    Deno.serve(() =>
      new Response("payments_disabled", {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        },
      })
    );
    return;
  }
  const db = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  Deno.serve(createRobokassaLiveResult({
    // Untyped generated schemas make Supabase's recursive select generics exceed Deno's depth.
    // The narrow transport contract is exercised with the pinned real SDK offline; all responses are validated.
    config,
    store: createLiveResultStore(db as unknown as LiveResultDatabase),
    // Only sanitized status metadata; no body, addresses, credentials, provider or DB exceptions.
    report: (event) => console.warn(JSON.stringify(event)),
  }));
}
