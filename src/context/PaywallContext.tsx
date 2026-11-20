import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { useApp } from './AppContext';
import { useTheme } from './ThemeContext';
import { LOCKED_LABEL, PAYWALL_GO, PAYWALL_LATER } from '../lib/planCopy';
import { usePlan } from './PlanContext';
import { BillingCheckNotice } from '../components/payments/BillingCheckNotice';

interface PaywallContextType {
  /** Tells the person that the thing is after payment and offers to go to it. Without extra words. */
  openPaywall: () => void;
}

const PaywallContext = createContext<PaywallContextType | null>(null);

/** The notice itself: a lock, the words, and the two ways out. Shown over whatever the person was doing. */
export function PaywallDialog({ onGo, onClose, verification }: { onGo: () => void; onClose: () => void; verification?: {checking:boolean;error:boolean;onRetry:()=>void} }) {
  const { theme } = useTheme();
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 px-4 pb-6 sm:items-center sm:pb-0"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="paywall-title"
        onClick={(event) => event.stopPropagation()}
        className={`w-full max-w-sm rounded-2xl border p-6 text-center ${theme.surface} ${theme.border}`}
      >
        {verification ? <><span id="paywall-title" className="sr-only">Проверка тарифа</span><BillingCheckNotice {...verification} /></> : <><Lock className="mx-auto mb-3 h-5 w-5 text-[#c9a96e]" strokeWidth={1.5} />
        <p id="paywall-title" className={`${theme.textPrimary} mb-5 text-base font-light`}>
          {LOCKED_LABEL}
        </p></>}
        <div className="flex flex-col gap-2">
          {!verification && <button
            type="button"
            autoFocus
            onClick={onGo}
            className={`w-full rounded-xl border py-3 text-sm font-light transition-all duration-200 ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover} ${theme.btnText}`}
          >
            {PAYWALL_GO}
          </button>}
          <button
            type="button"
            onClick={onClose}
            className={`w-full py-2.5 text-sm font-light ${theme.textMuted} hover:opacity-80`}
          >
            {PAYWALL_LATER}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One notice for everything that is closed on the person's plan: the attach button, the microphone, the memory switch,
 * the sections. It says "Доступно после оплаты" and offers to go to the payment, which is the tariffs screen.
 */
export function PaywallProvider({ children }: { children: ReactNode }) {
  const { navigateTo } = useApp();
  const {loaded,tier,ownerId,checking,verificationError,refresh}=usePlan();
  const [open, setOpen] = useState<'paywall'|'verification'|false>(false);

  const openPaywall = useCallback(() => setOpen(loaded?'paywall':'verification'), [loaded]);
  const close = useCallback(() => setOpen(false), []);
  // An upsell belongs to one verified identity/tier. Never carry it across re-verification or account change.
  useEffect(()=>{setOpen(false);},[loaded,tier,ownerId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const value = useMemo(() => ({ openPaywall }), [openPaywall]);

  return (
    <PaywallContext.Provider value={value}>
      {children}
      {open && (
        <PaywallDialog
          verification={open==='verification'||!loaded ? {checking,error:verificationError,onRetry:()=>void refresh()} : undefined}
          onGo={() => {
            setOpen(false);
            navigateTo('tariffs');
          }}
          onClose={close}
        />
      )}
    </PaywallContext.Provider>
  );
}

export function usePaywall(): PaywallContextType {
  const context = useContext(PaywallContext);
  if (!context) throw new Error('usePaywall must be used inside PaywallProvider');
  return context;
}
