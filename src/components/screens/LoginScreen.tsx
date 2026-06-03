import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import { mapResetPasswordError } from '../../lib/authErrors';
import { ROOM_COPY } from '../../lib/roomCopy';
import { Eye, EyeOff, Mail, Lock } from 'lucide-react';
import { ACCENT_TEXT_CLASS, AppContainer, LAYOUT_FORM_INNER_CLASS } from '../layout';

export function LoginScreen() {
  const { signIn } = useAuth();
  const { setCurrentScreen } = useApp();
  const { theme } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const { error } = await signIn(email, password);
      if (error) {
        setError(
          error.message === 'room_deleted'
            ? ROOM_COPY.roomDeletedLogin
            : 'Не удалось войти. Проверьте email и пароль.',
        );
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`min-h-screen ${theme.bg} flex flex-col`}>
      <AppContainer className="flex-1 flex flex-col py-10 sm:py-12">
        <button
          type="button"
          onClick={() => setCurrentScreen('welcome')}
          className={`self-start mb-5 sm:mb-6 ${theme.textMuted} transition-opacity duration-300 opacity-70 hover:opacity-100 text-lg`}
          aria-label="Назад"
        >
          ←
        </button>

        <div className={`flex-1 flex flex-col justify-center pb-6 ${LAYOUT_FORM_INNER_CLASS}`}>

          <div className="text-center mb-10 sm:mb-12">
            <p className={`${theme.textPrimary} text-[19px] sm:text-[22px] font-light leading-[1.75] tracking-tight`}>
              Иногда человеку важнее
            </p>
            <p className={`${theme.textPrimary} text-[19px] sm:text-[22px] font-light leading-[1.75] tracking-tight`}>
              не получить ответ,
            </p>
            <p className={`${theme.textPrimary} text-[19px] sm:text-[22px] font-light leading-[1.75] tracking-tight`}>
              а наконец <span className={ACCENT_TEXT_CLASS}>услышать</span> <span className={ACCENT_TEXT_CLASS}>себя</span>.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3.5">
            <div className="relative">
              <Mail className={`absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 ${theme.textMuted}`} strokeWidth={1.5} />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`
                  w-full border rounded-xl py-3.5 pl-11 pr-4 outline-none transition-all duration-200 font-light text-sm
                  ${theme.inputBg} ${theme.inputBorder} ${theme.inputBorderFocus} ${theme.inputText} ${theme.inputPlaceholder}
                `}
                placeholder="Email"
                required
              />
            </div>

            <div className="relative">
              <Lock className={`absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 ${theme.textMuted}`} strokeWidth={1.5} />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`
                  w-full border rounded-xl py-3.5 pl-11 pr-11 outline-none transition-all duration-200 font-light text-sm
                  ${theme.inputBg} ${theme.inputBorder} ${theme.inputBorderFocus} ${theme.inputText} ${theme.inputPlaceholder}
                `}
                placeholder="Пароль"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className={`absolute right-4 top-1/2 -translate-y-1/2 ${theme.textMuted} transition-colors duration-200`}
              >
                {showPassword
                  ? <EyeOff className="w-4 h-4" strokeWidth={1.5} />
                  : <Eye className="w-4 h-4" strokeWidth={1.5} />}
              </button>
            </div>

            {error && (
              <p className="text-red-400/75 text-xs font-light pt-0.5 text-center">{error}</p>
            )}
            {info && (
              <p className={`${theme.textSecondary} text-xs font-light pt-0.5 text-center`}>{info}</p>
            )}

            <button
              type="button"
              disabled={resetBusy || !email.trim()}
              onClick={async () => {
                setError(null);
                setInfo(null);
                setResetBusy(true);
                const { error: resetErr } = await supabase.auth.resetPasswordForEmail(
                  email.trim(),
                  { redirectTo: window.location.origin },
                );
                setResetBusy(false);
                if (resetErr) {
                  console.error('[resetPassword]', resetErr);
                  setError(mapResetPasswordError(resetErr.message));
                } else {
                  setInfo(ROOM_COPY.resetEmailHint);
                }
              }}
              className={`w-full text-center ${theme.textMuted} text-xs font-light underline underline-offset-2 decoration-dotted`}
            >
              {resetBusy ? 'Отправляю…' : 'Забыли пароль?'}
            </button>

            <button
              type="submit"
              disabled={loading}
              className={`
                w-full py-4 rounded-xl border transition-all duration-300 mt-1 disabled:opacity-50
                ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover}
              `}
            >
              <span className={`${theme.btnText} font-light text-sm tracking-widest`}>
                {loading ? '·  ·  ·' : 'Войти'}
              </span>
            </button>
          </form>

          <div className={`my-8 sm:my-9 h-px ${theme.divider} opacity-40`} />

          <div className="text-center space-y-2">
            <p className={`${theme.textMuted} text-xs font-light`}>Впервые здесь?</p>
            <button
              type="button"
              onClick={() => setCurrentScreen('register')}
              className={`${theme.textSecondary} text-sm font-light underline underline-offset-4 decoration-dotted transition-opacity duration-200 hover:opacity-80`}
            >
              Создать своё пространство
            </button>
          </div>

        </div>
      </AppContainer>
    </div>
  );
}
