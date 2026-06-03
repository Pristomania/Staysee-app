import { useEffect, useRef, type ReactNode } from 'react';
import { useTheme } from '../../context/ThemeContext';
import { AppContainer } from './AppContainer';

interface StickyScreenLayoutProps {
  header: ReactNode;
  /** Закреплённая зона под шапкой (ввод, действия) — не уезжает при прокрутке архива. */
  dock?: ReactNode;
  children: ReactNode;
  /** Доп. класс корневого контейнера */
  className?: string;
}

function canScroll(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight + 1;
}

function scrollByDelta(el: HTMLElement, deltaY: number): boolean {
  const max = el.scrollHeight - el.clientHeight;
  const next = Math.max(0, Math.min(max, el.scrollTop + deltaY));
  if (next === el.scrollTop) return false;
  el.scrollTop = next;
  return true;
}

/**
 * Экран на всю высоту: шапка и dock закреплены, архив прокручивается отдельно.
 * Колесо / тачпад работают сразу, без лишнего клика по контенту.
 */
export function StickyScreenLayout({
  header,
  dock,
  children,
  className = '',
}: StickyScreenLayoutProps) {
  const { theme } = useTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onWheel = (e: WheelEvent) => {
      const mainEl = mainRef.current;
      const dockEl = dockRef.current;
      if (!mainEl) return;

      const target = e.target as HTMLElement;
      if (target.closest('textarea, input, select, [contenteditable="true"]')) {
        return;
      }

      if (dockEl && dockEl.contains(target) && canScroll(dockEl)) {
        const atTop = dockEl.scrollTop <= 0;
        const atBottom =
          dockEl.scrollTop + dockEl.clientHeight >= dockEl.scrollHeight - 1;
        if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) {
          scrollByDelta(dockEl, e.deltaY);
          e.preventDefault();
          return;
        }
      }

      if (canScroll(mainEl)) {
        scrollByDelta(mainEl, e.deltaY);
        e.preventDefault();
      } else if (dockEl && canScroll(dockEl)) {
        scrollByDelta(dockEl, e.deltaY);
        e.preventDefault();
      }
    };

    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [Boolean(dock)]);

  return (
    <div
      ref={rootRef}
      className={`h-[100dvh] flex flex-col overflow-hidden ${theme.bg} ${className}`.trim()}
    >
      <div
        className={`shrink-0 z-30 border-b ${theme.border} border-opacity-30`}
        style={{
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          background: `linear-gradient(to bottom, ${theme.bgHex}f5, ${theme.bgHex}e8)`,
        }}
      >
        <AppContainer className="pt-4 sm:pt-5 pb-3 sm:pb-4">{header}</AppContainer>
      </div>

      {dock && (
        <div
          ref={dockRef}
          tabIndex={-1}
          className={`shrink-0 z-20 border-b ${theme.border} border-opacity-25 max-h-[min(52vh,420px)] overflow-y-auto overscroll-contain scrollbar-hide outline-none`}
          style={{
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            background: `${theme.bgHex}ee`,
          }}
        >
          <AppContainer className="py-3 sm:py-4">{dock}</AppContainer>
        </div>
      )}

      <div
        ref={mainRef}
        tabIndex={-1}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-hide outline-none"
      >
        <AppContainer className="py-4 sm:py-5 pb-10 sm:pb-12">{children}</AppContainer>
      </div>
    </div>
  );
}
