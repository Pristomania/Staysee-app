import type { ReactNode } from 'react';
import { useTheme, type Theme } from '../../context/ThemeContext';

/** Warm emotional accent — used sparingly on meaningful words. */
export const ACCENT_TEXT_CLASS = 'text-[#c9a96e]';

/**
 * Body paragraph typography — matches ProfileScreen (Контекст) guidance blocks.
 * @see ProfileScreen GUIDANCE_BLOCKS block.text / prompts
 */
export const CONTEXT_BODY_TYPO = 'font-light leading-relaxed';

/** Same color + weight + line-height as Context screen body copy. */
export function contextBodyTextClass(theme: Theme, sizeClass = ''): string {
  return [theme.textSecondary, CONTEXT_BODY_TYPO, sizeClass].filter(Boolean).join(' ');
}

export function useContextBodyTextClass(sizeClass = '') {
  const { theme } = useTheme();
  return contextBodyTextClass(theme, sizeClass);
}

export function useSectionLabelClass() {
  const { theme } = useTheme();
  return `${theme.textSecondary} text-[11px] sm:text-xs font-light tracking-[0.14em] uppercase mb-2.5 opacity-90`;
}

interface ScreenBackHeaderProps {
  onBack: () => void;
  title: string;
  subtitle?: string;
  backLabel?: string;
  /** В закреплённой шапке — без нижнего отступа. */
  pinned?: boolean;
  /** Кнопка справа (например «+») — в одной линии со стрелкой назад. */
  trailing?: ReactNode;
}

export function ScreenBackHeader({
  onBack,
  title,
  subtitle,
  backLabel = 'Назад',
  pinned = false,
  trailing,
}: ScreenBackHeaderProps) {
  const { theme } = useTheme();

  return (
    <header
      className={`flex items-center gap-3 sm:gap-4 ${pinned ? 'mb-0' : 'mb-5 sm:mb-6'}`}
    >
      <button
        type="button"
        onClick={onBack}
        className={`
          shrink-0 w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center rounded-xl border
          transition-all duration-300 opacity-75 hover:opacity-100
          ${theme.surface} ${theme.border} ${theme.surfaceHover}
        `}
        aria-label={backLabel}
      >
        <span className={`${theme.textSecondary} text-lg leading-none`}>←</span>
      </button>
      <div className="min-w-0 flex-1">
        <h1 className={`${theme.textPrimary} text-xl sm:text-[22px] font-light tracking-tight`}>
          {title}
        </h1>
        {subtitle && (
          <p className={`${theme.textMuted} text-xs font-light mt-0.5 opacity-80 truncate`}>
            {subtitle}
          </p>
        )}
      </div>
      {trailing}
    </header>
  );
}
