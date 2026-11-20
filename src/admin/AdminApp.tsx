import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AdminCallResult } from '../lib/admin/adminApi';
import { callAdminApi } from '../lib/admin/adminApiClient';
import { describeAdminError } from '../lib/admin/adminViewModels';
import type { AdminLabel } from '../lib/admin/adminTypes';
import { supabase } from '../lib/supabase';
import { AdminContext, type AdminContextValue } from './adminContext';
import { AdminLogin } from './AdminLogin';
import { CostsSection } from './sections/CostsSection';
import { ErrorsSection } from './sections/ErrorsSection';
import { FeedbackSection } from './sections/FeedbackSection';
import { OverviewSection } from './sections/OverviewSection';
import { PeopleSection } from './sections/PeopleSection';
import { Notice } from './ui';

type Phase = 'checking' | 'login' | 'ready' | 'error';
type Tab = 'overview' | 'people' | 'costs' | 'feedback' | 'errors';

const TABS: Array<{ key: Tab; title: string }> = [
  { key: 'overview', title: 'Обзор' },
  { key: 'people', title: 'Люди' },
  { key: 'costs', title: 'Расходы' },
  { key: 'feedback', title: 'Оценки' },
  { key: 'errors', title: 'Ошибки' },
];

/**
 * The admin panel. Opened only at /admin, as its own chunk.
 *
 * The gate is one call (the list of labels): the server decides who may come in. Not signed in, or the password entered too long ago,
 * shows the password step; a signed-in person who is not an admin is sent to the normal app without a word about the panel.
 */
export function AdminApp() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [labels, setLabels] = useState<AdminLabel[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [failure, setFailure] = useState('');

  // Every call goes through here, so any section that meets a refusal sends the person to the right place.
  const call = useCallback(async function call<T>(action: string, params: Record<string, unknown> = {}): Promise<AdminCallResult<T>> {
    const result = await callAdminApi<T>(action, params);
    if (!result.ok) {
      if (result.status === 403) window.location.replace('/');
      else if (result.status === 401) setPhase('login');
    }
    return result;
  }, []);

  const enter = useCallback(async () => {
    setPhase('checking');
    const result = await call<AdminLabel[]>('labels');
    if (result.ok) {
      setLabels(result.data);
      setPhase('ready');
    } else if (result.status === 401) {
      setPhase('login');
    } else if (result.status !== 403) {
      setFailure(describeAdminError(result.reason));
      setPhase('error');
    }
    // 403: call() has already sent the person to the normal app.
  }, [call]);

  useEffect(() => {
    document.title = 'Админ';
    void enter();
  }, [enter]);

  const context = useMemo<AdminContextValue>(() => ({ call, labels }), [call, labels]);

  async function signOut() {
    await supabase.auth.signOut();
    window.location.replace('/');
  }

  if (phase === 'login') return <Shell><AdminLogin onSignedIn={() => void enter()} /></Shell>;
  if (phase === 'checking') return <Shell><Notice tone="quiet">Загружаем…</Notice></Shell>;
  if (phase === 'error') {
    return (
      <Shell>
        <Notice tone="error">{failure}</Notice>
        <button type="button" onClick={() => void enter()} className="rounded border border-neutral-300 px-3 py-1 text-sm">
          Повторить
        </button>
      </Shell>
    );
  }

  return (
    <AdminContext.Provider value={context}>
      <Shell>
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 pb-3">
          <nav className="flex flex-wrap gap-1" aria-label="Разделы">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={`rounded px-3 py-1.5 text-sm ${tab === item.key ? 'bg-neutral-900 text-white' : 'text-neutral-700 hover:bg-neutral-100'}`}
              >
                {item.title}
              </button>
            ))}
          </nav>
          <button type="button" onClick={() => void signOut()} className="text-sm text-neutral-500 hover:text-neutral-900">
            Выйти
          </button>
        </header>
        {tab === 'overview' && <OverviewSection />}
        {tab === 'people' && <PeopleSection />}
        {tab === 'costs' && <CostsSection />}
        {tab === 'feedback' && <FeedbackSection />}
        {tab === 'errors' && <ErrorsSection />}
      </Shell>
    </AdminContext.Provider>
  );
}

function Shell(props: { children: ReactNode }) {
  return <div className="min-h-screen bg-neutral-50 px-4 py-6 text-neutral-900 md:px-8">{props.children}</div>;
}
