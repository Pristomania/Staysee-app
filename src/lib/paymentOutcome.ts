import { planRows } from "./planCopy";
import { PACK, PLANS } from "./plans";
import { parseServerTimestamp, parseServerTimestampMicros } from "./serverTime";

/** Internal, server-confirmed state, NOT a decoder for provider redirects or raw API JSON.
 * Live variants may only be supplied after the future fulfillment endpoint confirms the order.
 * No live consumer exists yet; current integration supplies test_paid only.
 */
export type PaymentOutcome =
  | { mode: "test"; status: "test_paid" }
  | { mode: "live"; status: "paid"; productId: "basic" | "premium" | "pack100" }
  | {
    mode: "live";
    status: "applied";
    productId: "basic" | "premium";
    paidUntil: string;
    /** Time of a fresh server entitlement check, not device time or a historical callback. */
    verifiedAt: string;
  }
  | { mode: "live"; status: "applied"; productId: "pack100" };

export interface PaymentOutcomeCopy {
  title: string;
  body: string;
  benefits: string[];
  dateLine?: string;
}

export function paymentOutcomeCopy(result: PaymentOutcome): PaymentOutcomeCopy {
  if (result.mode === "test") {
    return {
      title: "Тестовая оплата прошла",
      body: "Деньги не списаны. Тариф и сообщения не изменились.",
      benefits: [],
    };
  }
  if (result.status === "paid") {
    return {
      title: result.productId === "pack100"
        ? "Добавляем сообщения…"
        : "Подключаем ваш тариф…",
      body:
        "Оплата подтверждена. Обновляем доступ — повторно платить не нужно.",
      benefits: [],
    };
  }
  if (result.productId === "pack100") {
    return {
      title: `Добавлено ${PACK.messages} сообщений`,
      body:
        "Они доступны в ваших беседах. Тариф и срок его действия не изменились.",
      benefits: [],
    };
  }
  const until = parseServerTimestamp(result.paidUntil);
  const now = parseServerTimestamp(result.verifiedAt);
  if (!Number.isFinite(until) || !Number.isFinite(now)) {
    return {
      title: "Уточняем срок тарифа…",
      body:
        "Оплата подтверждена. Проверяем состояние доступа — повторно платить не нужно.",
      benefits: [],
    };
  }
  if (
    parseServerTimestampMicros(result.paidUntil)! <=
      parseServerTimestampMicros(result.verifiedAt)!
  ) {
    return {
      title: "Оплаченный период завершён",
      body:
        "Этот платёж подтверждён, но срок оплаченного доступа уже закончился. Текущее состояние можно посмотреть в тарифах.",
      benefits: [],
    };
  }
  const plan = PLANS[result.productId];
  return {
    title: `Тариф «${plan.label}» подключён`,
    body: "Теперь вам доступны:",
    benefits: planRows(plan).filter((row) => row.included).map((row) =>
      row.text
    ),
    dateLine: `Оплачен до ${
      new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Europe/Moscow",
      }).format(until)
    }`,
  };
}
