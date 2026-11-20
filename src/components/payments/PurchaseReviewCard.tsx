import type { TestProduct } from "../../lib/paymentTestClient";
import * as React from "react";
import { purchaseReview } from "../../lib/purchaseReview";
import { useTheme } from "../../context/ThemeContext";
export function PurchaseReviewCard(
  { product, onCancel, onConfirm }: {
    product: TestProduct;
    onCancel: () => void;
    onConfirm: () => void;
  },
) {
  const { theme } = useTheme(),
    view = purchaseReview(product),
    id = React.useId();
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    heading.current?.focus();
  }, []);
  const button =
    `rounded-xl border px-4 py-3 text-sm ${theme.btnBg} ${theme.btnText} ${theme.btnBorder}`;
  return (
    <section
      aria-labelledby={id}
      className={`rounded-xl border p-5 ${theme.surface} ${theme.border}`}
    >
      <p className={`${theme.textSecondary} text-xs`}>
        Проверка условий — тестовый режим
      </p>
      <h2
        id={id}
        ref={heading}
        tabIndex={-1}
        className={`${theme.textPrimary} mt-2 text-xl outline-none`}
      >
        {view.title}
      </h2>
      <p className={`${theme.textPrimary} mt-2 text-lg`}>
        {view.priceRub.toLocaleString("ru-RU")} ₽{" "}
        <span className="text-sm">— цена продукта, без списания в тесте</span>
      </p>
      <p className={`${theme.textPrimary} mt-4 text-sm`}>{view.testNotice}</p>
      <ul
        className={`${theme.textSecondary} mt-4 list-disc space-y-2 pl-5 text-sm`}
      >
        {view.conditions.map((text) => <li key={text}>{text}</li>)}
      </ul>
      <p className={`${theme.textSecondary} mt-4 text-xs`}>
        {view.purchaseMode}
      </p>
      <p className={`${theme.textSecondary} mt-2 text-xs`}>
        Показаны условия продукта. Возможность настоящей покупки проверяет
        сервер; этот тест не даёт доступ.
      </p>
      <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
        <button
          type="button"
          className={`${button} flex-1`}
          onClick={onConfirm}
        >
          Создать тестовый заказ
        </button>
        <button type="button" className={`${button} flex-1`} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </section>
  );
}
