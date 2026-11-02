import { Link2 } from 'lucide-react';
import { ConfirmedDelete } from './ConfirmedDelete';
import { LockedBadge } from './LockedBadge';
import { useAuth } from '../context/AuthContext';
import { deleteAllMemory } from '../lib/deleteAccountData';
import { supabaseAccountDataDeps } from '../lib/deleteAccountDataDeps';
import { ROOM_COPY } from '../lib/roomCopy';
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
  const { user } = useAuth();
  const sectionLabel = useSectionLabelClass();

  return (
    <>
      <section className="mb-8">
        <p className={sectionLabel}>Память этой беседы</p>
        <p className={`${theme.textSecondary} mb-3 text-xs font-light leading-relaxed`}>{MEMORY_HINT}</p>
      </section>

      <section>
        <p className={sectionLabel}>Сквозная память</p>
        <div className={`${cardBase} px-4 py-3.5`}>
          <div className="flex items-start gap-3">
            <Link2 className={`mt-0.5 h-4 w-4 shrink-0 ${theme.textMuted}`} strokeWidth={1.5} />
            <div className="min-w-0 flex-1">
              <p className={`${theme.textPrimary} text-sm font-light`}>Сквозная память</p>
              <p className={`${theme.textSecondary} text-xs font-light`}>{MEMORY_HINT}</p>
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

      {/* The memory is not shown on this plan, but the person can always wipe all of it. */}
      <section className="mt-8">
        <p className={sectionLabel}>Удаление памяти</p>
        <ConfirmedDelete
          hint={ROOM_COPY.deleteMemoryHint}
          buttonLabel={ROOM_COPY.deleteMemoryButton}
          doneText={ROOM_COPY.deleteMemoryDone}
          confirmGoes={ROOM_COPY.deleteMemoryConfirmGoes}
          confirmStays={ROOM_COPY.deleteMemoryConfirmStays}
          onRun={async () => (user ? deleteAllMemory(supabaseAccountDataDeps) : false)}
        />
      </section>
    </>
  );
}

/**
 * A section of a plan that does not have it: what it is, and the "after payment" button. The name is given only where
 * the screen does not already say it in its own header.
 */
export function LockedFeaturePanel({ title, hint }: { title?: string; hint: string }) {
  const { theme } = useTheme();
  const { openPaywall } = usePaywall();
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-4 ${theme.surface} ${theme.border}`}>
      <div className="min-w-0 flex-1">
        {title && <p className={`${theme.textPrimary} text-sm font-light`}>{title}</p>}
        <p className={`${theme.textSecondary} text-xs font-light leading-relaxed`}>{hint}</p>
      </div>
      <LockedBadge onClick={openPaywall} />
    </div>
  );
}
