import { Lock } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { LOCKED_LABEL } from '../lib/planCopy';

/** The small button that stands on everything closed on the person's plan. Without extra words. */
export function LockedBadge({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  const { theme } = useTheme();
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#c9a96e]/35 bg-[#c9a96e]/8 px-2.5 py-1 text-[11px] font-light ${theme.btnText} ${className}`}
    >
      <Lock className="h-3 w-3" strokeWidth={1.5} />
      {LOCKED_LABEL}
    </button>
  );
}
