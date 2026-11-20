import * as React from "react";
import { useTheme } from "../../context/ThemeContext";
import {
  type PaymentOutcome,
  paymentOutcomeCopy,
} from "../../lib/paymentOutcome";

export function PaymentOutcomeCard({ result, onConversations }: {
  result: PaymentOutcome;
  onConversations: () => void;
}) {
  const { theme } = useTheme();
  const view = paymentOutcomeCopy(result);
  const headingId = React.useId();
  return (
    <section
      aria-labelledby={headingId}
      className={`rounded-xl border p-5 ${theme.surface} ${theme.border}`}
    >
      <div role="status" aria-live="polite" aria-atomic="true">
        <h2
          id={headingId}
          className={`${theme.textPrimary} text-xl font-light`}
        >
          {view.title}
        </h2>
        <p className={`${theme.textSecondary} mt-3 text-sm`}>{view.body}</p>
        {view.benefits.length > 0 && (
          <ul
            className={`${theme.textPrimary} mt-4 list-disc space-y-2 pl-5 text-sm`}
          >
            {view.benefits.map((text) => <li key={text}>{text}</li>)}
          </ul>
        )}
        {view.dateLine && (
          <p className={`${theme.textSecondary} mt-4 text-sm`}>
            {view.dateLine}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onConversations}
        className={`mt-5 w-full rounded-xl border px-4 py-3 text-sm ${theme.btnBg} ${theme.btnText} ${theme.btnBorder} ${theme.btnBgHover}`}
      >
        Перейти к беседам
      </button>
    </section>
  );
}
