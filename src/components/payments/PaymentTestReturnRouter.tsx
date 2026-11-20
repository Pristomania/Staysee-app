import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useApp } from "../../context/AppContext";
import { shouldResumePayment } from "../../lib/paymentTestClient";
import {
  paymentTestStorage,
  paymentTestUiEnabled,
} from "../../lib/paymentTestBrowser";

export function PaymentTestReturnRouter() {
  const [search] = useState(() => window.location.search);
  const handled = useRef(false);
  const { user, loading, passwordRecoveryPending } = useAuth();
  const { replaceNavigation, currentScreen } = useApp();
  useEffect(() => {
    if (
      !paymentTestUiEnabled || handled.current || loading || !user ||
      currentScreen === "reset-password"
    ) return;
    if (
      !shouldResumePayment(
        search,
        user.id,
        passwordRecoveryPending,
        paymentTestStorage,
      )
    ) return;
    handled.current = true;
    replaceNavigation("tariffs");
  }, [
    user,
    loading,
    passwordRecoveryPending,
    currentScreen,
    search,
    replaceNavigation,
  ]);
  return null;
}
