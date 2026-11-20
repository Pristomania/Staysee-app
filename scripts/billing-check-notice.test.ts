import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../src/context/ThemeContext.tsx";
import { BillingCheckNotice } from "../src/components/payments/BillingCheckNotice.tsx";
test("unverified billing offers verification, not repeat payment", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null },
  });
  try {
    const html = renderToStaticMarkup(
      React.createElement(ThemeProvider, {
        children: React.createElement(BillingCheckNotice, {
          checking: false,
          error: true,
          onRetry: () => {
            throw Error("render must not retry");
          },
        }),
      }),
    );
    assert.match(html, /Не удалось проверить тариф/);
    assert.match(html, /Повторно оплачивать не нужно/);
    assert.match(html, />Проверить тариф<\/button>/);
    assert.doesNotMatch(
      html,
      /Перейти к оплате|Оплатить|Доступно после оплаты/,
    );
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
