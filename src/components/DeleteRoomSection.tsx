import { useState } from 'react';
import { Lock, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { requestRoomDeletion } from '../lib/requestRoomDeletion';
import { ROOM_COPY } from '../lib/roomCopy';
import { supabase } from '../lib/supabase';

interface DeleteRoomSectionProps {
  cardClass: string;
  onDeleted: () => void | Promise<void>;
}

export function DeleteRoomSection({ cardClass, onDeleted }: DeleteRoomSectionProps) {
  const { user } = useAuth();
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    setOpen(false);
    setPassword('');
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const email = user?.email?.trim();
    if (!email) {
      setError('Не удалось проверить пароль. Выйдите и войдите снова.');
      return;
    }
    if (!password) {
      setError(ROOM_COPY.deleteRoomPasswordWrong);
      return;
    }

    setBusy(true);
    const { error: authErr } = await supabase.auth.signInWithPassword({ email, password });
    if (authErr) {
      setBusy(false);
      setError(ROOM_COPY.deleteRoomPasswordWrong);
      return;
    }

    const result = await requestRoomDeletion();
    setBusy(false);
    if (!result.ok) {
      setError('Не удалось удалить комнату. Попробуйте позже.');
      return;
    }
    await onDeleted();
    close();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`
          w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-red-400/20
          ${theme.surface} ${theme.surfaceHover} transition-colors
        `}
        aria-label={ROOM_COPY.deleteRoomAction}
      >
        <Trash2 className="w-4 h-4 text-red-400/70" strokeWidth={1.5} />
        <span className="text-red-400/80 text-xs font-light">{ROOM_COPY.deleteRoomAction}</span>
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className={`rounded-xl border border-red-400/20 ${cardClass} px-4 py-4 space-y-3`}
    >
      <p className={`${theme.textMuted} text-xs font-light leading-relaxed`}>
        {ROOM_COPY.deleteRoomHint}
      </p>

      <div className="relative">
        <Lock
          className={`absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 ${theme.textMuted}`}
          strokeWidth={1.5}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          placeholder={ROOM_COPY.deleteRoomPasswordPlaceholder}
          className={`
            w-full border rounded-xl py-3 pl-10 pr-4 outline-none font-light text-sm
            ${theme.inputBg} ${theme.inputBorder} ${theme.inputText} ${theme.inputPlaceholder}
          `}
        />
      </div>

      {error && (
        <p className="text-red-400/75 text-xs font-light">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={close}
          disabled={busy}
          className={`flex-1 py-2.5 rounded-xl border text-xs font-light ${theme.border} ${theme.textMuted} disabled:opacity-50`}
        >
          {ROOM_COPY.deleteRoomCancel}
        </button>
        <button
          type="submit"
          disabled={busy || !password}
          className="flex-1 py-2.5 rounded-xl border border-red-400/30 text-red-400/90 text-xs font-light disabled:opacity-50"
        >
          {busy ? '·  ·  ·' : ROOM_COPY.deleteRoomSubmit}
        </button>
      </div>
    </form>
  );
}
