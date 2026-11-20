import type { TestProduct } from "./paymentTestClient";
import { PACK, PLANS } from "./plans";
export interface PurchaseReview {
  title: string;
  priceRub: number;
  messages: number;
  periodDays: number | null;
  validMonths: number | null;
  conditions: string[];
  testNotice: string;
  purchaseMode: string;
}
export function restoreReviewFocus(
  button: Pick<HTMLElement, "focus"> | null,
  disclosure: Pick<HTMLDetailsElement, "open"> | null,
): void {
  if (!button) return;
  if (disclosure) disclosure.open = true;
  button.focus();
}
/** Product explanation only. The server alone decides real eligibility and stores the final price. */
export function purchaseReview(product: TestProduct): PurchaseReview {
  if (!["basic", "premium", "pack100"].includes(product)) {
    throw Error("invalid_product");
  }
  const common = {
    testNotice:
      "Деньги не списываются. Тариф не изменится. Боевой чек не оформляется.",
    purchaseMode:
      "Разовая покупка — тестовый сценарий. Автопродление в этом тесте не подключается.",
  };
  const renewal =
    `После любой настоящей покупки новые бесплатные ${PLANS.free.messages} сообщений больше не начисляются.`;
  if (product === "pack100") {
    return {
      ...common,
      title: `${PACK.messages} сообщений`,
      priceRub: PACK.priceRub,
      messages: PACK.messages,
      periodDays: null,
      validMonths: PACK.validMonths,
      conditions: [
        `При настоящей покупке: ${PACK.messages} сообщений, срок — ${PACK.validMonths} месяцев с покупки.`,
        "Докупленные сообщения расходуются после включённых в тариф.",
        "Покупка пакета не меняет тариф и его срок, не открывает дополнительные функции.",
        "При первой докупке первоначальный пробный остаток сохраняется.",
        renewal,
      ],
    };
  }
  const plan = PLANS[product];
  return {
    ...common,
    title: `Тариф «${plan.label}»`,
    priceRub: plan.priceRub,
    messages: plan.messages,
    periodDays: plan.periodDays,
    validMonths: null,
    conditions: [
      `При настоящей покупке: полная цена ${
        plan.priceRub.toLocaleString("ru-RU")
      } ₽, новый срок ${plan.periodDays} дней с подтверждения оплаты.`,
      `Новый включённый лимит — ${plan.messages} сообщений. Остатки предыдущего тарифа с ним не суммируются.`,
      ...(product === "premium"
        ? [
          "При повышении с «Базового» старый тариф прекращается, его включённые сообщения не переносятся.",
        ]
        : []),
      "Ранее докупленные сообщения сохраняются: их остаток и прежний срок не меняются.",
      "Неиспользованный пробный остаток после покупки тарифа завершается.",
      renewal,
    ],
  };
}
