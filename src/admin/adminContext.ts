import { createContext, useContext } from 'react';
import type { AdminCallResult } from '../lib/admin/adminApi';
import type { AdminLabel } from '../lib/admin/adminTypes';

/** What every section of the panel gets: the call to admin-api (which sends the person back to the password when it is refused) and the labels. */
export interface AdminContextValue {
  call<T>(action: string, params?: Record<string, unknown>): Promise<AdminCallResult<T>>;
  labels: AdminLabel[];
}

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error('useAdmin is used outside the admin panel');
  return value;
}
