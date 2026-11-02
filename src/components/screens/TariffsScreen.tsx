import { Check, Lock } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { usePlan } from '../../context/PlanContext';
import { useTheme } from '../../context/ThemeContext';
import { PAYMENT_AVAILABLE } from '../../lib/payments';
import { counterLine, renewalLine } from '../../lib/messageCounter';
import { PAYMENT_STATUS_LINE, planRows, priceLine } from '../../lib/planCopy';
import { PLANS, type PlanId } from '../../lib/plans';
import { ScreenBackHeader, StickyScreenLayout } from '../layout';

const ORDER: PlanId[] = ['free', 'basic', 'premium'];

/**
 * The tariffs inside the cabinet: what each plan gives, the person's own counter, and the way to payment. Every closed
 * thing stays on the card, shown as closed, so the person sees what opens with a plan.
 */
export function TariffsScreen() {
  const { navigateBack } = useApp();
  const { theme } = useTheme();
  const { tier, plan: current, counter } = usePlan();

  const card = `rounded-xl border ${theme.surface} ${theme.border}`;

  return (
    <StickyScreenLayout
      header={(
        <ScreenBackHeader
          pinned
          onBack={() => navigateBack()}
          title="Тарифы"
          subtitle="Что входит в каждый"
          backLabel="Назад"
        />
      )}
    >
      {counter && (
        <div className={`${card} mb-6 px-4 py-3`}>
          <p className={`${theme.textSecondary} text-sm font-light`}>
            {current.label} · {counterLine(counter)}
          </p>
          {renewalLine(counter, tier) && (
            <p className={`${theme.textSecondary} mt-1 text-xs font-light`}>{renewalLine(counter, tier)}</p>
          )}
        </div>
      )}

      <div className="space-y-4 pb-8">
        {ORDER.map((id) => {
          const plan = PLANS[id];
          const isCurrent = id === tier;
          return (
            <section
              key={id}
              data-plan={id}
              className={`${card} px-5 py-5 ${isCurrent ? 'border-[#c9a96e]/55' : ''}`}
            >
              <div className="mb-1 flex items-center justify-between gap-3">
                <p className={`${theme.textPrimary} text-base font-light`}>{plan.label}</p>
                {isCurrent && <span className="text-[11px] font-light text-[#c9a96e]">Ваш тариф</span>}
              </div>
              <p className={`${theme.textSecondary} mb-4 text-sm font-light`}>{priceLine(plan)}</p>

              <ul className="mb-4 space-y-2">
                {planRows(plan).map((row) => (
                  <li key={row.text} className="flex items-start gap-2.5">
                    {row.included ? (
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#c9a96e]" strokeWidth={1.8} />
                    ) : (
                      <Lock className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${theme.textMuted} opacity-60`} strokeWidth={1.5} />
                    )}
                    <span className={`${theme.textSecondary} ${row.included ? '' : 'opacity-75'} text-sm font-light`}>
                      {row.text}
                    </span>
                  </li>
                ))}
              </ul>

              {id !== 'free' && !isCurrent && (
                // No payment is connected yet, so the button cannot take money and says so. When the payment service is
                // connected, this becomes the real button together with PAYMENT_AVAILABLE (a test keeps the two together).
                <button
                  type="button"
                  disabled
                  className={`w-full rounded-xl border py-3 text-sm font-light transition-all duration-200 disabled:opacity-50 ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover} ${theme.btnText}`}
                >
                  Оплата скоро
                </button>
              )}
            </section>
          );
        })}
        {!PAYMENT_AVAILABLE && (
          <p className={`${theme.textSecondary} text-center text-xs font-light`}>{PAYMENT_STATUS_LINE}</p>
        )}
      </div>
    </StickyScreenLayout>
  );
}
