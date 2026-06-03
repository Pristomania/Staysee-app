import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';

export function GreetingScreen() {
  const { setCurrentScreen } = useApp();
  const { theme } = useTheme();

  return (
    <div className={`min-h-screen ${theme.bg} flex flex-col`}>
      {/* Back */}
      <button
        onClick={() => setCurrentScreen('welcome')}
        className={`absolute top-8 left-6 ${theme.textMuted} transition-colors duration-300 text-lg`}
      >
        ←
      </button>

      <div className="flex-1 flex flex-col items-center justify-center px-8 max-w-sm mx-auto w-full">

        {/* Identity line — calm presence, not muted */}
        <p className={`${theme.textSecondary} text-sm font-light tracking-[0.18em] mb-14`}>
          Я StaySee AI.
        </p>

        {/* Headline */}
        <div className="text-center mb-14">
          <p className={`${theme.textPrimary} text-[19px] sm:text-xl font-light leading-[1.8] tracking-tight`}>
            Иногда человеку важнее
          </p>
          <p className={`${theme.textPrimary} text-[19px] sm:text-xl font-light leading-[1.8] tracking-tight`}>
            не получить ответ,
          </p>
          <p className={`${theme.textPrimary} text-[19px] sm:text-xl font-light leading-[1.8] tracking-tight`}>
            а наконец услышать себя.
          </p>
        </div>

        {/* Button */}
        <button
          onClick={() => setCurrentScreen('login')}
          className={`
            w-full py-4 rounded-xl border transition-all duration-300
            ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover}
          `}
        >
          <span className={`${theme.btnText} font-light text-sm tracking-widest`}>
            Продолжить
          </span>
        </button>

      </div>
    </div>
  );
}
