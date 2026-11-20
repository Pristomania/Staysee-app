import { useEffect, useState } from 'react';
import { describeAdminError } from '../lib/admin/adminViewModels';
import { useAdmin } from './adminContext';

export interface AdminLoad<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
}

/** Loads one thing from admin-api whenever its parameters change (or reload() is called); a failure becomes plain words. */
export function useAdminLoad<T>(action: string, params: Record<string, unknown>): AdminLoad<T> {
  const { call } = useAdmin();
  const key = JSON.stringify(params);
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void call<T>(action, JSON.parse(key) as Record<string, unknown>).then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { data: result.data, error: null, loading: false }
          : { data: null, error: describeAdminError(result.reason), loading: false },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [call, action, key, tick]);

  return {
    ...state,
    reload: () => {
      setState((previous) => ({ ...previous, loading: true }));
      setTick((n) => n + 1);
    },
  };
}
