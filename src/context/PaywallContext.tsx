import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { useApp } from './AppContext';
import { useTheme } from './ThemeContext';
import { LOCKED_LABEL, PAYWALL_GO, PAYWALL_LATER } from '../lib/planCopy';

interface PaywallContextType {
  /** Tells the person that the thing is after payment and offers to go to it. Without extra words. */
  openPaywall: () => void;
}

const PaywallContext = createContext<PaywallContextType | null>(null);

/** The notice itself: a lock, the words, and the two ways out. Shown over whatever the person was doing. */
export function PaywallDialog({ onGo, onClose }: { onGo: () => void; onClose: () => void }) {
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
        <Lock className="mx-auto mb-3 h-5 w-5 text-[#c9a96e]" strokeWidth={1.5} />
        <p id="paywall-title" className={`${theme.textPrimary} mb-5 text-base font-light`}>
          {LOCKED_LABEL}
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            autoFocus
            onClick={onGo}
            className={`w-full rounded-xl border py-3 text-sm font-light transition-all duration-200 ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover} ${theme.btnText}`}
          >
            {PAYWALL_GO}
          </button>
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
  const [open, setOpen] = useState(false);

  const openPaywall = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

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
