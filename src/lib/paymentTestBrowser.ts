import { supabase } from "./supabase";
import { resolveSupabasePublicConfig } from "./supabaseEnv";
import {
  authorizeTestCheckout,
  createPaymentTestApi,
  type PaymentTestStorage,
  type TestCheckout,
} from "./paymentTestClient";

export const paymentTestUiEnabled =
  import.meta.env.VITE_ROBOKASSA_TEST_UI === "1";
export const paymentTestStorage: PaymentTestStorage = {
  getItem: (key) => window.sessionStorage.getItem(key),
  setItem: (key, value) => window.sessionStorage.setItem(key, value),
};
async function currentSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) return null;
  return { userId: data.session.user.id, token: data.session.access_token };
}
export function browserPaymentTestApi(userId: string) {
  const { url, anonKey } = resolveSupabasePublicConfig();
  return createPaymentTestApi({
    userId,
    baseUrl: url,
    anonKey,
    session: currentSession,
  });
}
export async function submitTestCheckout(
  userId: string,
  raw: TestCheckout,
  signal: AbortSignal,
) {
  const checkout = await authorizeTestCheckout(
    userId,
    raw,
    currentSession,
    signal,
  );
  if (signal.aborted) throw Error("cancelled");
  const form = document.createElement("form");
  form.method = "POST";
  form.action = checkout.action;
  form.acceptCharset = "utf-8";
  form.hidden = true;
  for (const [name, value] of Object.entries(checkout.fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  try {
    HTMLFormElement.prototype.submit.call(form);
  } finally {
    form.remove();
  }
}
