import { Link2 } from 'lucide-react';
import { LockedBadge } from './LockedBadge';
import { useTheme } from '../context/ThemeContext';
import { usePaywall } from '../context/PaywallContext';
import { useSectionLabelClass } from './layout';

const MEMORY_HINT = 'Факты будут видны после оплаты.';

/**
 * The memory screen of a plan without memory between conversations. The person sees the sections and the switch, and
 * understands that they open after payment: the switch itself carries the "after payment" button.
 */
export function LockedMemoryPanel({ cardBase }: { cardBase: string }) {
  const { theme } = useTheme();
  const { openPaywall } = usePaywall();
  const sectionLabel = useSectionLabelClass();

  return (
    <>
      <section className="mb-8">
        <p className={sectionLabel}>Память этой беседы</p>
        <p className={`${theme.textMuted} mb-3 text-xs font-light leading-relaxed opacity-85`}>{MEMORY_HINT}</p>
      </section>

      <section>
        <p className={sectionLabel}>Сквозная память</p>
        <div className={`${cardBase} px-4 py-3.5`}>
          <div className="flex items-start gap-3">
            <Link2 className={`mt-0.5 h-4 w-4 shrink-0 ${theme.textMuted}`} strokeWidth={1.5} />
            <div className="min-w-0 flex-1">
              <p className={`${theme.textPrimary} text-sm font-light`}>Сквозная память</p>
              <p className={`${theme.textMuted} text-xs font-light opacity-85`}>{MEMORY_HINT}</p>
            </div>
          </div>
          {/* The button stands right at the switch it explains. */}
          <div className="mt-3 flex items-center justify-between gap-3 pl-7">
            <LockedBadge onClick={openPaywall} />
            <button
              type="button"
              role="switch"
              aria-checked={false}
              aria-label="Сквозная память. Доступно после оплаты"
              onClick={openPaywall}
              className={`relative h-6 w-11 shrink-0 rounded-full border opacity-70 ${theme.border}`}
            >
              <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[#ece9e3] shadow-sm" />
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

/** A section of a plan that does not have it: its name, what it is, and the "after payment" button. */
export function LockedFeaturePanel({ title, hint }: { title: string; hint: string }) {
  const { theme } = useTheme();
  const { openPaywall } = usePaywall();
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-4 ${theme.surface} ${theme.border}`}>
      <div className="min-w-0 flex-1">
        <p className={`${theme.textPrimary} text-sm font-light`}>{title}</p>
        <p className={`${theme.textMuted} text-xs font-light leading-relaxed opacity-85`}>{hint}</p>
      </div>
      <LockedBadge onClick={openPaywall} />
    </div>
  );
}
