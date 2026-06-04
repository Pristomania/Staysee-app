import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { Eye, EyeOff, Mail, Lock } from 'lucide-react';
import { mapSignUpError } from '../../lib/authErrors';
import { ROOM_COPY } from '../../lib/roomCopy';
import { ACCENT_TEXT_CLASS, AppContainer, LAYOUT_FORM_INNER_CLASS } from '../layout';

export function RegisterScreen() {
  const { signUp } = useAuth();
  const { navigateTo } = useApp();
  const { theme } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmedAge18, setConfirmedAge18] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const canSubmit = confirmedAge18 && acceptedTerms && !loading;

  const openTerms = () => {
    navigateTo('terms', { legalReturnScreen: 'register' });
  };

  const openPrivacy = () => {
    navigateTo('privacy', { legalReturnScreen: 'register' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!confirmedAge18) {
      setError(ROOM_COPY.age18Required);
      return;
    }
    if (!acceptedTerms) {
      setError('Нужно принять публичную оферту');
      return;
    }
    if (password !== confirmPassword) { setError('Пароли не совпадают'); return; }
    if (password.length < 6) { setError('Пароль — минимум 6 символов'); return; }
    setLoading(true);
    try {
      const result = await signUp(email, password);
      if (result.error) {
        setError(mapSignUpError(result.error.message));
        return;
      }
      if (result.status === 'already_registered') {
        setError(ROOM_COPY.roomExistsEmail);
        return;
      }
      if (result.status === 'confirm_email') {
        setInfo(
          `На ${email.trim()} отправлено письмо для подтверждения. После перехода по ссылке можно войти.`,
        );
        return;
      }
      // status === 'session' — App переключит экран на main / onboarding
    } catch {
      setError(mapSignUpError('auth_timeout'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`min-h-screen ${theme.bg} flex flex-col`}>
      <AppContainer className="flex-1 flex flex-col py-8 sm:py-10">
        <button
          type="button"
          onClick={() => navigateTo('login')}
          className={`self-start mb-6 sm:mb-8 ${theme.textMuted} transition-opacity duration-300 opacity-70 hover:opacity-100 text-lg`}
        >
          ←
        </button>

        <div className={`flex-1 flex flex-col justify-center pb-6 ${LAYOUT_FORM_INNER_CLASS}`}>

        <div className="text-center mb-10 sm:mb-12">
          <h1 className={`${theme.textPrimary} text-[19px] sm:text-xl font-light leading-[1.75] tracking-tight mb-2`}>
            Создаём <span className={ACCENT_TEXT_CLASS}>пространство</span>.
          </h1>
          <p className={`${theme.textSecondary} text-sm font-light leading-[1.75] opacity-90`}>
            Ваше личное место для беседы.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3.5">
          {/* Email */}
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

          {/* Password */}
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

          {/* Confirm password */}
          <div className="relative">
            <Lock className={`absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 ${theme.textMuted}`} strokeWidth={1.5} />
            <input
              type={showConfirmPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={`
                w-full border rounded-xl py-3.5 pl-11 pr-11 outline-none transition-all duration-200 font-light text-sm
                ${theme.inputBg} ${theme.inputBorder} ${theme.inputBorderFocus} ${theme.inputText} ${theme.inputPlaceholder}
              `}
              placeholder="Повторите пароль"
              required
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              className={`absolute right-4 top-1/2 -translate-y-1/2 ${theme.textMuted} transition-colors duration-200`}
            >
              {showConfirmPassword
                ? <EyeOff className="w-4 h-4" strokeWidth={1.5} />
                : <Eye className="w-4 h-4" strokeWidth={1.5} />}
            </button>
          </div>

          <label className="flex items-start gap-3 pt-1 cursor-pointer group">
            <input
              type="checkbox"
              checked={confirmedAge18}
              onChange={(e) => setConfirmedAge18(e.target.checked)}
              className="mt-1 w-4 h-4 rounded border border-white/20 bg-transparent accent-[#c9a96e] flex-shrink-0"
            />
            <span className={`${theme.textMuted} text-xs font-light leading-[1.65] group-hover:opacity-90`}>
              {ROOM_COPY.age18Confirm}
            </span>
          </label>

          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
              className="mt-1 w-4 h-4 rounded border border-white/20 bg-transparent accent-[#c9a96e] flex-shrink-0"
            />
            <span className={`${theme.textMuted} text-xs font-light leading-[1.65] group-hover:opacity-90`}>
              Я принимаю{' '}
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  openTerms();
                }}
                className={`${theme.textSecondary} underline underline-offset-2 decoration-dotted`}
              >
                публичную оферту
              </button>
              {' '}и ознакомлен(а) с{' '}
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  openPrivacy();
                }}
                className={`${theme.textSecondary} underline underline-offset-2 decoration-dotted`}
              >
                политикой конфиденциальности
              </button>
              .
            </span>
          </label>

          {error && (
            <p className="text-red-400/75 text-xs font-light pt-0.5">{error}</p>
          )}
          {info && (
            <p className={`${theme.textSecondary} text-xs font-light pt-0.5 leading-relaxed`}>{info}</p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={!canSubmit}
            className={`
              w-full py-4 rounded-xl border transition-all duration-300 mt-1 disabled:opacity-50
              ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover}
            `}
          >
            <span className={`${theme.btnText} font-light text-sm tracking-widest`}>
              {loading ? '·  ·  ·' : 'Создать своё пространство'}
            </span>
          </button>
        </form>

        {/* Divider */}
        <div className={`my-9 h-px ${theme.divider} opacity-60`} />

        {/* Login link */}
        <div className="text-center space-y-2">
          <p className={`${theme.textMuted} text-xs font-light`}>{ROOM_COPY.alreadyHaveRoom}</p>
          <button
            onClick={() => navigateTo('login')}
            className={`${theme.textSecondary} text-sm font-light underline underline-offset-4 decoration-dotted transition-opacity duration-200 hover:opacity-80`}
          >
            Войти
          </button>
        </div>

        </div>
      </AppContainer>
    </div>
  );
}
