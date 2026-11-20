import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type PaymentOutcome,
  paymentOutcomeCopy,
} from "../src/lib/paymentOutcome.ts";
import { PaymentOutcomeCard } from "../src/components/payments/PaymentOutcomeCard.tsx";
import { ThemeProvider } from "../src/context/ThemeContext.tsx";

const verifiedAt = "2026-11-20T12:00:00Z";
test("applied plans describe their actual features and server expiry, not an unbuilt AI voice", () => {
  const basic = paymentOutcomeCopy({
    mode: "live",
    status: "applied",
    productId: "basic",
    paidUntil: "2026-12-20T21:30:00Z",
    verifiedAt,
  });
  assert.match(basic.title, /Базовый.*подключён/);
  assert.deepEqual(basic.benefits, [
    "400 сообщений на 30 дней",
    "3 беседы",
    "Сквозная память",
    "Динамика бесед",
    "Прикрепление файлов",
    "Голосовой ввод",
  ]);
  assert.equal(basic.dateLine, "Оплачен до 21 декабря 2026 г.");
  const premium = paymentOutcomeCopy({
    mode: "live",
    status: "applied",
    productId: "premium",
    paidUntil: "2026-12-20T12:00:00Z",
    verifiedAt,
  });
  assert.match(premium.title, /Премиум.*подключён/);
  assert.equal(premium.benefits[0], "1 000 сообщений на 30 дней");
  assert.equal(premium.benefits[1], "6 бесед");
  assert.doesNotMatch(premium.benefits.join(" "), /ИИ/);
});
test("paid awaiting fulfillment offers no active benefits or payment retry", () => {
  const view = paymentOutcomeCopy({
    mode: "live",
    status: "paid",
    productId: "basic",
  });
  assert.equal(view.title, "Подключаем ваш тариф…");
  assert.deepEqual(view.benefits, []);
  assert.equal(view.dateLine, undefined);
  assert.match(view.body, /Оплата подтверждена/);
  assert.doesNotMatch(view.body, /оплатите|оплатить снова/i);
  assert.equal(
    paymentOutcomeCopy(
      { mode: "live", status: "paid", productId: "pack100" },
    ).title,
    "Добавляем сообщения…",
  );
});
test("package success adds messages, never promises a changed tariff or thirty-day access", () => {
  const view = paymentOutcomeCopy({
    mode: "live",
    status: "applied",
    productId: "pack100",
  });
  assert.equal(view.title, "Добавлено 100 сообщений");
  assert.deepEqual(view.benefits, []);
  assert.equal(view.dateLine, undefined);
  assert.match(view.body, /Тариф и срок его действия не изменились/);
});
test("test receipt cannot become real activation", () => {
  const view = paymentOutcomeCopy({ mode: "test", status: "test_paid" });
  assert.equal(view.title, "Тестовая оплата прошла");
  assert.deepEqual(view.benefits, []);
  assert.match(view.body, /Деньги не списаны/);
  assert.match(view.body, /Тариф и сообщения не изменились/);
});
test("expired or malformed expiry cannot announce an active plan", () => {
  for (
    const paidUntil of [
      "",
      "not-a-date",
      "2026-11-20T12:00:00Z",
      "2026-11-19T12:00:00Z",
    ]
  ) {
    const view = paymentOutcomeCopy({
      mode: "live",
      status: "applied",
      productId: "basic",
      paidUntil,
      verifiedAt,
    });
    assert.doesNotMatch(view.title, /подключён/);
    assert.deepEqual(view.benefits, []);
  }
});

test("ambiguous and impossible server dates never announce active access", () => {
  for (
    const paidUntil of [
      "2027",
      "2027-01-01",
      "2027-01-01T12:00:00",
      "2027-02-30T00:00:00Z",
      "2027-02-29T00:00:00Z",
      "2027-04-31T00:00:00+03:00",
      "2027-01-01T24:00:00Z",
    ]
  ) {
    const view = paymentOutcomeCopy({
      mode: "live",
      status: "applied",
      productId: "basic",
      paidUntil,
      verifiedAt,
    });
    assert.equal(view.title, "Уточняем срок тарифа…", paidUntil);
    assert.deepEqual(view.benefits, []);
  }
  for (
    const paidUntil of [
      "2028-02-29T00:00:00.123456+00:00",
      "2027-12-20T12:00:00+03:00",
    ]
  ) {
    const view = paymentOutcomeCopy({
      mode: "live",
      status: "applied",
      productId: "basic",
      paidUntil,
      verifiedAt,
    });
    assert.match(view.title, /подключён/);
  }
});

test("local device clock cannot activate access when server time is missing or expired", () => {
  const original = Date.now;
  Date.now = () => Date.parse("2026-11-18T12:00:00Z");
  try {
    const expired = {
      mode: "live",
      status: "applied",
      productId: "basic",
      paidUntil: "2026-11-19T12:00:00Z",
      verifiedAt: "2026-11-20T12:00:00Z",
    } as const;
    assert.equal(
      paymentOutcomeCopy(expired).title,
      "Оплаченный период завершён",
    );
    const missing = {
      ...expired,
      paidUntil: "2027-01-01T00:00:00Z",
      verifiedAt: undefined,
    } as unknown as PaymentOutcome;
    assert.equal(paymentOutcomeCopy(missing).title, "Уточняем срок тарифа…");
  } finally {
    Date.now = original;
  }
});
test("real result card renders accessible CTA and date; test card stays unmistakably test-only", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null },
  });
  try {
    const render = (result: PaymentOutcome) =>
      renderToStaticMarkup(
        React.createElement(ThemeProvider, {
          children: React.createElement(PaymentOutcomeCard, {
            result,
            onConversations: () => {
              throw Error("render must not navigate");
            },
          }),
        }),
      );
    const html = render({
      mode: "live",
      status: "applied",
      productId: "basic",
      paidUntil: "2026-12-20T12:00:00Z",
      verifiedAt,
    });
    assert.match(
      html,
      /<button[^>]*type="button"[^>]*>Перейти к беседам<\/button>/,
    );
    assert.match(html, /Оплачен до/);
    assert.match(html, /role="status"/);
    const testHtml = render({ mode: "test", status: "test_paid" });
    assert.match(testHtml, /Тестовая оплата прошла/);
    assert.doesNotMatch(testHtml, /Базовый.*подключён/);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
