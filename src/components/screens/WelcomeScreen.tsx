import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { ROOM_COPY } from '../../lib/roomCopy';
import { ACCENT_TEXT_CLASS, AppContainer, LAYOUT_FORM_INNER_CLASS } from '../layout';

export function WelcomeScreen() {
  const { setCurrentScreen } = useApp();
  const { theme } = useTheme();

  return (
    <div className={`min-h-screen ${theme.bg} flex flex-col`}>
      <AppContainer className="flex-1 flex flex-col items-center justify-center py-12 sm:py-16">
        <div className={LAYOUT_FORM_INNER_CLASS}>

          <div className="text-center mb-10 sm:mb-12">
            <h1 className={`${theme.textPrimary} text-2xl font-light tracking-wide mb-2`}>
              StaySee AI
            </h1>
            <p className="text-[#b8a882]/75 text-xs font-light tracking-widest uppercase">
              Точка опоры для осознанной жизни
            </p>
          </div>

          <div className="text-center mb-10 sm:mb-12">
            <p className={`${theme.textPrimary} text-[19px] sm:text-xl font-light leading-[1.75] tracking-tight`}>
              Иногда внутри слишком много <span className={ACCENT_TEXT_CLASS}>всего</span>,
            </p>
            <p className={`${theme.textPrimary} text-[19px] sm:text-xl font-light leading-[1.75] tracking-tight`}>
              чтобы держать это в <span className={ACCENT_TEXT_CLASS}>себе</span>.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setCurrentScreen('login')}
            className={`
              w-full py-4 rounded-xl border transition-all duration-300
              ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover}
            `}
          >
            <span className={`${theme.btnText} font-light text-sm tracking-widest`}>
              Войти
            </span>
          </button>

          <button
            type="button"
            onClick={() => setCurrentScreen('register')}
            className={`mt-3 w-full py-3 ${theme.textMuted} text-sm font-light underline underline-offset-4 decoration-dotted hover:opacity-80`}
          >
            {ROOM_COPY.createRoom}
          </button>

          <p className={`mt-7 text-center ${theme.textMuted} text-xs font-light tracking-wide`}>
            Здесь можно побыть собой.
          </p>

        </div>
      </AppContainer>
    </div>
  );
}
