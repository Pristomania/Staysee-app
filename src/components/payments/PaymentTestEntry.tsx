import { useMemo } from "react";
import { useAuth } from "../../context/AuthContext";
import { useApp } from "../../context/AppContext";
import {
  browserPaymentTestApi,
  paymentTestStorage,
  paymentTestUiEnabled,
  submitTestCheckout,
} from "../../lib/paymentTestBrowser";
import { PaymentTestPanel } from "./PaymentTestPanel";

export function PaymentTestEntry() {
  const { user } = useAuth();
  const { navigateTo } = useApp();
  const api = useMemo(
    () => user && paymentTestUiEnabled ? browserPaymentTestApi(user.id) : null,
    [user?.id],
  );
  if (!user || !api) return null;
  return (
    <PaymentTestPanel
      key={user.id}
      userId={user.id}
      api={api}
      storage={paymentTestStorage}
      onConversations={() => navigateTo("main", { conversation: null })}
      onCheckout={(checkout, signal) =>
        submitTestCheckout(user.id, checkout, signal)}
    />
  );
}
