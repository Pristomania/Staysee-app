import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentTestPanel } from "../src/components/payments/PaymentTestPanel.tsx";
import { ThemeProvider } from "../src/context/ThemeContext.tsx";

test("test panel warns about no real charge/access before offering any checkout", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null },
  });
  try {
    const html = renderToStaticMarkup(
      React.createElement(ThemeProvider, {
        children: React.createElement(PaymentTestPanel, {
          userId: "fixture-user",
          api: {
            capabilities: async () => {},
            create: async () => {
              throw Error("not on render");
            },
            status: async () => {
              throw Error("not on render");
            },
          },
          storage: { getItem: () => null, setItem: () => {} },
          onCheckout: () => {
            throw Error("not on render");
          },
          onConversations: () => {
            throw Error("render must not navigate");
          },
        }),
      }),
    );
    assert.match(html, /Деньги не списываются/);
    assert.match(html, /Тариф не изменится/);
    assert.doesNotMatch(html, /<form|Перейти к тестовой оплате/);
    assert.doesNotMatch(html, /Тестовая оплата прошла|Перейти к беседам/);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
