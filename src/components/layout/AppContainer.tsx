import type { ElementType, ReactNode } from 'react';

/** Unified content column: 760px max, centered, 20px / 24px horizontal padding. */
export const LAYOUT_CONTAINER_CLASS =
  'w-full max-w-[760px] mx-auto px-5 sm:px-6';

/** Narrow inner column for auth forms — same shell, comfortable field width. */
export const LAYOUT_FORM_INNER_CLASS = 'w-full max-w-md mx-auto';

interface AppContainerProps {
  children: ReactNode;
  className?: string;
  as?: ElementType;
}

export function AppContainer({ children, className = '', as: Tag = 'div' }: AppContainerProps) {
  return <Tag className={`${LAYOUT_CONTAINER_CLASS} ${className}`.trim()}>{children}</Tag>;
}
