import * as React from "react";
import { useTheme } from "../../context/ThemeContext";
import { PACK, PLANS } from "../../lib/plans";
import { PaymentOutcomeCard } from "./PaymentOutcomeCard";
import { PurchaseReviewCard } from "./PurchaseReviewCard";
import { restoreReviewFocus } from "../../lib/purchaseReview";
import {
  type PaymentTestApi,
  PaymentTestController,
  type PaymentTestState,
  type PaymentTestStorage,
  type TestCheckout,
  type TestProduct,
} from "../../lib/paymentTestClient";

const products: { id: TestProduct; title: string; price: number }[] = [
  { id: "basic", title: PLANS.basic.label, price: PLANS.basic.priceRub },
  { id: "premium", title: PLANS.premium.label, price: PLANS.premium.priceRub },
  { id: "pack100", title: "100 сообщений", price: PACK.priceRub },
];
const descriptions: Record<PaymentTestState["phase"], string> = {
  loading: "Проверяем доступ к тестированию…",
  unavailable: "Тестовая оплата недоступна для этой сессии.",
  ready: "Выберите продукт для проверки.",
  creating: "Готовим тестовый заказ…",
  pending:
    "Заказ ожидает подтверждения сервера. Возврат с платёжной страницы сам по себе не означает успех.",
  test_paid:
    "Тестовый платёж подтверждён сервером. Деньги не списаны, тариф и сообщения не изменились.",
  expired: "Срок тестового заказа истёк. Можно начать новую проверку.",
  error:
    "Не удалось подтвердить состояние. Проверьте прежний заказ — новый автоматически не создаётся.",
};

/** Separate panel, never substitutes for enabled production payment buttons. */
export function PaymentTestPanel(
  { userId, api, storage, onCheckout, onConversations }: {
    userId: string;
    api: PaymentTestApi;
    storage: PaymentTestStorage;
    onCheckout: (checkout: TestCheckout, signal: AbortSignal) => Promise<void>;
    onConversations: () => void;
  },
) {
  const { theme } = useTheme();
  const [state, setState] = React.useState<PaymentTestState>({
    phase: "loading",
  });
  const [controller, setController] = React.useState<PaymentTestController>();
  const binding = React.useRef<
    {
      owner: string;
      api: PaymentTestApi;
      storage: PaymentTestStorage;
      model: PaymentTestController;
    }
  >();
  const currentModel =
    binding.current?.owner === userId && binding.current.api === api &&
      binding.current.storage === storage &&
      binding.current.model === controller
      ? controller
      : undefined;
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState(false);
  const [review, setReview] = React.useState<
    {
      product: TestProduct;
      owner: string;
      api: PaymentTestApi;
      storage: PaymentTestStorage;
      model: PaymentTestController;
    } | null
  >(null);
  const productRefs = React.useRef<
    Partial<Record<TestProduct, HTMLButtonElement | null>>
  >({});
  const returnFocus = React.useRef<TestProduct | null>(null);
  const repeatDisclosure = React.useRef<HTMLDetailsElement>(null);
  const validReview = review && review.owner === userId && review.api === api &&
      review.storage === storage && review.model === currentModel &&
      ["ready", "expired", "test_paid"].includes(state.phase)
    ? review
    : null;
  React.useEffect(() => {
    if (!validReview && returnFocus.current) {
      restoreReviewFocus(
        productRefs.current[returnFocus.current] ?? null,
        repeatDisclosure.current,
      );
      returnFocus.current = null;
    }
  }, [validReview]);
  React.useEffect(() => {
    setReview(null);
  }, [userId, api, storage]);
  const submitAbort = React.useRef<AbortController>();
  React.useEffect(() => {
    const abort = new AbortController();
    submitAbort.current = abort;
    return () => abort.abort();
  }, [userId, api, storage, state.phase]);
  React.useEffect(() => {
    const model = new PaymentTestController(
      userId,
      api,
      storage,
      () => crypto.randomUUID(),
    );
    const unsubscribe = model.subscribe(setState);
    binding.current = { owner: userId, api, storage, model };
    setController(model);
    setState(model.state);
    void model.init();
    return () => {
      unsubscribe();
      model.dispose();
    };
  }, [userId, api, storage]);
  React.useEffect(() => {
    if (!controller || state.phase !== "pending") return;
    let checks = 0;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (++checks >= 20) clearInterval(timer);
      void controller.check();
    }, 3000);
    return () => clearInterval(timer);
  }, [controller, state.phase]);
  const button =
    `rounded-xl border px-4 py-3 text-sm disabled:opacity-50 ${theme.btnBg} ${theme.btnText} ${theme.btnBorder}`;
  const choose = ["ready", "expired"].includes(state.phase);
  const productButtons = (
    <div className="mt-4 grid gap-2 sm:grid-cols-3">
      {products.map((p) => (
        <button
          type="button"
          key={p.id}
          ref={(node) => {
            productRefs.current[p.id] = node;
          }}
          className={button}
          disabled={!currentModel}
          onClick={() => {
            setSubmitError(false);
            if (
              currentModel &&
              ["ready", "expired", "test_paid"].includes(state.phase)
            ) {
              setReview({
                product: p.id,
                owner: userId,
                api,
                storage,
                model: currentModel,
              });
            }
          }}
        >
          {p.title} · {p.price.toLocaleString("ru-RU")} ₽{" "}
          <span className="block text-xs">тест без списания</span>
        </button>
      ))}
    </div>
  );
  if (validReview) {
    return (
      <PurchaseReviewCard
        product={validReview.product}
        onCancel={() => {
          returnFocus.current = validReview.product;
          setReview(null);
        }}
        onConfirm={() => {
          setReview(null);
          void validReview.model.start(validReview.product);
        }}
      />
    );
  }
  if (state.phase === "test_paid") {
    return (
      <div className="space-y-3">
        <PaymentOutcomeCard
          result={{ mode: "test", status: "test_paid" }}
          onConversations={onConversations}
        />
        <details
          ref={repeatDisclosure}
          className={`${theme.textSecondary} text-sm`}
        >
          <summary className="cursor-pointer">
            Проверить ещё один продукт
          </summary>
          {productButtons}
        </details>
      </div>
    );
  }
  return (
    <section
      aria-label="Тестовая оплата"
      className={`rounded-xl border p-5 ${theme.surface} ${theme.border}`}
    >
      <h2 className={`${theme.textPrimary} text-base`}>
        Проверка оплаты — тестовый режим
      </h2>
      <p className={`${theme.textSecondary} mt-2 text-sm`}>
        Деньги не списываются. Тариф не изменится.
      </p>
      <p
        role="status"
        aria-live="polite"
        className={`${theme.textPrimary} mt-4 text-sm`}
      >
        {descriptions[state.phase]}
      </p>
      {state.attempt && (
        <p className={`${theme.textSecondary} mt-2 break-all text-xs`}>
          Продукт: {products.find((p) =>
            p.id === state.attempt?.productId
          )?.title} · {state.attempt.invoiceId
            ? `Заказ ${state.attempt.invoiceId}`
            : "Номер ещё не подтверждён"}
        </p>
      )}
      {choose && productButtons}
      {state.phase === "pending" && state.checkout && (
        <button
          type="button"
          className={`${button} mt-4 w-full`}
          disabled={submitting}
          onClick={async () => {
            const abort = submitAbort.current;
            if (
              !state.checkout || submitting || !abort || abort.signal.aborted
            ) return;
            setSubmitting(true);
            setSubmitError(false);
            try {
              await onCheckout(state.checkout, abort.signal);
            } catch {
              setSubmitError(true);
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Перейти к тестовой оплате
        </button>
      )}
      {state.phase === "pending" && !state.checkout && (
        <button
          type="button"
          className={`${button} mt-3 w-full`}
          onClick={() => void controller?.retry()}
        >
          Восстановить переход к прежнему заказу
        </button>
      )}
      {state.attempt && ["error", "pending"].includes(state.phase) && (
        <button
          type="button"
          className={`${button} mt-3 w-full`}
          onClick={() => {
            if (state.attempt?.invoiceId) void controller?.check();
            else void controller?.retry();
          }}
        >
          Проверить прежний заказ
        </button>
      )}
      {state.error === "storage" && (
        <p role="alert" className={`${theme.textPrimary} mt-3 text-sm`}>
          Браузер не сохранил номер попытки. Оплата не запущена. Разрешите
          хранение данных страницы и обновите её.
        </p>
      )}
      {state.error === "monthly_order_pending" && (
        <p role="alert" className={`${theme.textPrimary} mt-3 text-sm`}>
          Новый заказ не создан: уже есть незавершённый заказ тарифа. Откройте
          прежнюю вкладку или дождитесь его завершения. Пакет сообщений можно
          проверить отдельно.
        </p>
      )}
      {state.error === "too_many_orders" && (
        <p role="alert" className={`${theme.textPrimary} mt-3 text-sm`}>
          Новый заказ не создан: слишком много попыток. Подождите перед
          следующей проверкой.
        </p>
      )}
      {submitError && (
        <p role="alert" className={`${theme.textPrimary} mt-3 text-sm`}>
          Переход не выполнен. Проверьте вход и состояние прежнего заказа.
        </p>
      )}
    </section>
  );
}
