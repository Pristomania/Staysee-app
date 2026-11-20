import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';

/**
 * The password step of the panel. Whoever opens /admin signs in again with the password (the panel accepts a password entered within the
 * last 30 minutes); the message on a failure is the same whatever went wrong, so it says nothing about who may enter.
 */
export function AdminLogin(props: { onSignedIn(): void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const known = data.session?.user.email;
      if (known) setEmail((current) => current || known);
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    setPassword('');
    if (error) {
      setFailed(true);
      return;
    }
    props.onSignedIn();
  }

  return (
    <div className="mx-auto mt-24 max-w-sm rounded-lg border border-neutral-200 bg-white p-6">
      <h1 className="mb-4 text-lg font-semibold text-neutral-900">Вход</h1>
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Почта"
          className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
        />
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Пароль"
          autoFocus
          className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || email.trim() === '' || password === ''}
          className="w-full rounded bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-40"
        >
          {busy ? 'Входим…' : 'Войти'}
        </button>
        {failed && <p className="text-sm text-red-700">Не получилось войти. Проверь почту и пароль.</p>}
      </form>
    </div>
  );
}
