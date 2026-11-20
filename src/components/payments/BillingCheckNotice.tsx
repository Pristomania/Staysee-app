import * as React from "react";
import { useTheme } from "../../context/ThemeContext";
export function BillingCheckNotice(
  { checking, error, onRetry }: {
    checking: boolean;
    error: boolean;
    onRetry: () => void;
  },
) {
  const { theme } = useTheme();
  return React.createElement(
    "section",
    {
      role: "status",
      className: `mb-4 rounded-xl border p-4 ${theme.surface} ${theme.border}`,
    },
    React.createElement(
      "p",
      { className: `text-sm ${theme.textPrimary}` },
      error ? "Не удалось проверить тариф" : "Проверяем тариф…",
    ),
    React.createElement(
      "p",
      { className: `mt-2 text-xs ${theme.textSecondary}` },
      "Повторно оплачивать не нужно. Дождитесь проверки или попробуйте ещё раз.",
    ),
    React.createElement("button", {
      type: "button",
      disabled: checking,
      onClick: onRetry,
      className:
        `mt-3 w-full rounded-xl border px-4 py-3 text-sm disabled:opacity-50 ${theme.btnBg} ${theme.btnText} ${theme.btnBorder}`,
    }, "Проверить тариф"),
  );
}
