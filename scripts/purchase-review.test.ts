import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  purchaseReview,
  restoreReviewFocus,
} from "../src/lib/purchaseReview.ts";
import { PLANS } from "../src/lib/plans.ts";
import { PurchaseReviewCard } from "../src/components/payments/PurchaseReviewCard.tsx";
import { ThemeProvider } from "../src/context/ThemeContext.tsx";

test("Premium review discloses full price/new term/replacement and separately bought messages", () => {
  const view = purchaseReview("premium");
  assert.equal(view.priceRub, 4900);
  assert.equal(view.messages, 1000);
  assert.equal(view.periodDays, 30);
  const text = view.conditions.join(" ");
  assert.match(text, /не переносятся/);
  assert.match(text, /докупленные/);
  assert.match(text, /прежни.*срок/);
  assert.match(text, /пробн/);
});
test("Basic review uses current catalog and never adds unused included messages to new limit", () => {
  const view = purchaseReview("basic");
  assert.equal(view.priceRub, 1990);
  assert.equal(view.messages, 400);
  assert.equal(view.periodDays, 30);
  assert.match(view.conditions.join(" "), /не суммируются/);
});
test("pack adds100 after included quota, retains initial trial and never grants paid features", () => {
  const view = purchaseReview("pack100");
  assert.equal(view.priceRub, 590);
  assert.equal(view.messages, 100);
  assert.equal(view.validMonths, 12);
  assert.equal(view.periodDays, null);
  assert.match(view.conditions.join(" "), /после/);
  assert.match(view.conditions.join(" "), /пробный остаток сохраняется/);
  assert.match(view.conditions.join(" "), /не открывает/);
});
test("all real purchases permanently stop future free renewal, review has no invented autorenewal", () => {
  for (const product of ["basic", "premium", "pack100"] as const) {
    const v = purchaseReview(product);
    assert.match(v.conditions.join(" "), /бесплатные 50.*не начисляются/);
    assert.match(v.testNotice, /не списываются/);
    assert.match(v.testNotice, /Тариф не изменится/);
    assert.match(v.purchaseMode, /Разовая/);
  }
  assert.throws(() => purchaseReview("free" as never), /invalid_product/);
});
test("review rendering cannot create an order, shows accessible explicit test actions and no form", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null },
  });
  let actions = 0;
  try {
    const html = renderToStaticMarkup(
      React.createElement(ThemeProvider, {
        children: React.createElement(PurchaseReviewCard, {
          product: "premium",
          onCancel: () => actions++,
          onConfirm: () => actions++,
        }),
      }),
    );
    assert.equal(actions, 0);
    assert.match(html, /Создать тестовый заказ/);
    assert.match(html, /Отмена/);
    assert.match(html, /не списываются/);
    assert.match(html, /aria-labelledby/);
    assert.doesNotMatch(html, /<form|action=|Подписаться|Оплатить сейчас/);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
test("repeat cancel reopens disclosure before focusing the selected product", () => {
  const disclosure = { open: false };
  let focused = false;
  restoreReviewFocus({
    focus() {
      assert.equal(disclosure.open, true);
      focused = true;
    },
  }, disclosure);
  assert.equal(focused, true);
});
test("normal cancel focuses its product without requiring a disclosure", () => {
  let focused = false;
  restoreReviewFocus({
    focus() {
      focused = true;
    },
  }, null);
  assert.equal(focused, true);
});
test("renewal disclosure follows free allowance catalog rather than literal50", () => {
  const previous = PLANS.free.messages;
  try {
    PLANS.free.messages = 73;
    for (const product of ["basic", "premium", "pack100"] as const) {
      assert.match(
        purchaseReview(product).conditions.join(" "),
        /бесплатные 73/,
      );
    }
  } finally {
    PLANS.free.messages = previous;
  }
});
