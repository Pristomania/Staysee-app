import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { ACCENT_TEXT_CLASS, AppContainer, LAYOUT_FORM_INNER_CLASS } from '../layout';

export function ResetPasswordScreen() {
  const { completePasswordRecovery, abandonPasswordRecovery } = useAuth();
  const { replaceNavigation } = useApp();
  const { theme } = useTheme();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkedSession, setCheckedSession] = useState(false);
  const [hasRecoverySession, setHasRecoverySession] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function ensureRecoverySession() {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      setHasRecoverySession(Boolean(session?.user));
      setCheckedSession(true);
    }
    void ensureRecoverySession();
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError('Пароль — минимум 6 символов');
      return;
    }
    if (password !== confirmPassword) {
      setError('Пароли не совпадают');
      return;
    }
    setLoading(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
      setLoading(false);
      setError('Ссылка устарела. На экране входа снова нажмите «Забыли пароль?» и откройте новое письмо.');
      return;
    }
    const { error: updateErr } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (updateErr) {
      setError('Не удалось сохранить пароль. Запросите новую ссылку на экране входа.');
      return;
    }
    completePasswordRecovery();
    replaceNavigation('main');
  };

  if (!checkedSession) {
    return (
      <div className={`min-h-screen ${theme.bg} flex flex-col items-center justify-center gap-4 px-6`}>
        <div className={`w-6 h-6 border-2 ${theme.spinnerBorder} ${theme.spinnerTop} rounded-full animate-spin`} />
        <p className={`${theme.textMuted} text-xs font-light text-center max-w-xs`}>
          Подключаем ссылку для нового пароля…
        </p>
      </div>
    );
  }

  if (!hasRecoverySession) {
    return (
      <div className={`min-h-screen ${theme.bg} flex flex-col`}>
        <AppContainer className="flex-1 flex flex-col justify-center py-12">
          <div className={`text-center space-y-4 ${LAYOUT_FORM_INNER_CLASS}`}>
            <p className={`${theme.textPrimary} text-lg font-light`}>Ссылка уже не действует</p>
            <p className={`${theme.textMuted} text-sm font-light leading-relaxed`}>
              Каждая ссылка из письма работает один раз. Запросите новую на экране входа — «Забыли пароль?».
              Старый пароль при этом не меняется, пока вы не сохраните новый на этом экране.
            </p>
            <button
              type="button"
              onClick={() => {
                void abandonPasswordRecovery().then(() => replaceNavigation('login'));
              }}
              className={`
                w-full py-4 rounded-xl border mt-4
                ${theme.btnBg} ${theme.btnBorder}
              `}
            >
              <span className={`${theme.btnText} font-light text-sm tracking-widest`}>На экран входа</span>
            </button>
          </div>
        </AppContainer>
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${theme.bg} flex flex-col`}>
      <AppContainer className="flex-1 flex flex-col py-10 sm:py-12">
        <div className={`flex-1 flex flex-col justify-center pb-6 ${LAYOUT_FORM_INNER_CLASS}`}>
          <div className="text-center mb-10 sm:mb-12">
            <p className={`${theme.textPrimary} text-[19px] sm:text-[22px] font-light leading-[1.75] tracking-tight`}>
              Новый <span className={ACCENT_TEXT_CLASS}>пароль</span>
            </p>
            <p className={`${theme.textMuted} text-xs font-light mt-3`}>
              Задайте пароль для входа в StaySee AI
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3.5">
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
                placeholder="Новый пароль"
                required
                minLength={6}
                autoComplete="new-password"
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

            <div className="relative">
              <Lock className={`absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 ${theme.textMuted}`} strokeWidth={1.5} />
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={`
                  w-full border rounded-xl py-3.5 pl-11 pr-4 outline-none transition-all duration-200 font-light text-sm
                  ${theme.inputBg} ${theme.inputBorder} ${theme.inputBorderFocus} ${theme.inputText} ${theme.inputPlaceholder}
                `}
                placeholder="Повторите пароль"
                required
                minLength={6}
                autoComplete="new-password"
              />
            </div>

            {error && (
              <p className="text-red-400/75 text-xs font-light pt-0.5 text-center">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className={`
                w-full py-4 rounded-xl border transition-all duration-300 mt-1 disabled:opacity-50
                ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover}
              `}
            >
              <span className={`${theme.btnText} font-light text-sm tracking-widest`}>
                {loading ? '·  ·  ·' : 'Сохранить и войти'}
              </span>
            </button>
          </form>

          <div className="text-center mt-8">
            <button
              type="button"
              onClick={() => {
                void abandonPasswordRecovery().then(() => replaceNavigation('login'));
              }}
              className={`${theme.textMuted} text-xs font-light underline underline-offset-2 decoration-dotted`}
            >
              На экран входа
            </button>
          </div>
        </div>
      </AppContainer>
    </div>
  );
}
