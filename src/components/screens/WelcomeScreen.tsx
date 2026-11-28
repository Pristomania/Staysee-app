import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { ROOM_COPY } from '../../lib/roomCopy';
import { AppContainer, LAYOUT_FORM_INNER_CLASS } from '../layout';
import { PublicLegalLinks } from '../legal/PublicLegalLinks';

export function WelcomeScreen() {
  const { navigateTo } = useApp();
  const { theme } = useTheme();
  const taglineColor = theme.name === 'light' ? 'text-[#786346]' : 'text-[#c9a96e]';

  return (
    <div className={`min-h-screen ${theme.bg} flex flex-col`}>
      <AppContainer className="flex-1 flex flex-col items-center justify-center py-12 sm:py-16">
        <div className={LAYOUT_FORM_INNER_CLASS}>

          <div className="text-center mb-10 sm:mb-12">
            <h1 className={`${theme.textPrimary} text-2xl font-light tracking-wide mb-2`}>
              StaySee AI
            </h1>
            <p className={`${taglineColor} text-xs font-light tracking-widest uppercase`}>
              Точка опоры для осознанной жизни
            </p>
          </div>

          <div className="text-center mb-10 sm:mb-12">
            <p className={`${theme.textPrimary} text-[19px] sm:text-xl font-light leading-[1.75] tracking-tight`}>
              Иногда внутри слишком много всего,
            </p>
            <p className={`${theme.textPrimary} text-[19px] sm:text-xl font-light leading-[1.75] tracking-tight`}>
              чтобы держать это в себе.
            </p>
          </div>

          <button
            type="button"
            onClick={() => navigateTo('login')}
            className={`
              w-full py-4 rounded-xl border transition-all duration-300
              ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover}
            `}
          >
            <span className={`${theme.btnText} font-semibold text-sm tracking-widest`}>
              Войти
            </span>
          </button>

          <button
            type="button"
            onClick={() => navigateTo('register')}
            className={`mt-3 w-full py-3 rounded-xl border bg-transparent transition-colors duration-300 ${theme.btnBorder} ${theme.btnBorderHover} ${theme.btnBgHover} ${theme.btnText} text-sm font-light tracking-wide focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4`}
          >
            {ROOM_COPY.createRoom}
          </button>

          <p className={`mt-7 text-center ${theme.textMuted} text-xs font-light tracking-wide`}>
            Здесь можно побыть собой.
          </p>

        </div>
        <PublicLegalLinks className={theme.textSecondary} />
      </AppContainer>
    </div>
  );
}
