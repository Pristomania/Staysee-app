import { Palette } from 'lucide-react';
import { useTheme, type ThemeName } from '../context/ThemeContext';
import { THEME_PREVIEW } from '../lib/themePreviews';

const ORDER: ThemeName[] = ['deep', 'light', 'mist'];

/** Коротко в узкой колонке; полное имя — в title и aria-label. */
const DISPLAY_LABEL: Record<ThemeName, string> = {
  deep: 'Ночь',
  light: 'Тишина',
  mist: 'Туман',
};

export function ThemePicker() {
  const { theme, themeName, setTheme, allThemes } = useTheme();

  const card = `w-full rounded-xl border ${theme.surface} ${theme.border}`;

  return (
    <div className={`${card} flex items-center gap-3 px-4 py-3`}>
      <Palette
        className={`w-4 h-4 ${theme.textSecondary} shrink-0 opacity-75`}
        strokeWidth={1.5}
        aria-hidden
      />
      <p className={`${theme.textPrimary} text-sm font-light shrink-0`}>Оформление</p>

      <div className="flex-1 grid grid-cols-3 gap-2 min-w-0">
        {ORDER.map((name) => {
          const meta = allThemes[name];
          const active = themeName === name;
          const sw = THEME_PREVIEW[name];

          return (
            <button
              key={name}
              type="button"
              onClick={() => setTheme(name)}
              aria-pressed={active}
              aria-label={meta.label}
              title={meta.label}
              className={`
                w-full flex flex-col items-center gap-1 min-w-0
                rounded-lg py-1.5 px-1 transition-colors
                ${active ? 'bg-[#c9a96e]/[0.08]' : theme.surfaceHover}
              `}
            >
              <span
                className={`
                  block w-full h-5 rounded-md transition-all
                  ${active ? 'ring-1 ring-[#c9a96e]/50' : ''}
                `}
                style={{
                  background: `linear-gradient(180deg, ${sw.bg} 55%, ${sw.surface} 100%)`,
                  boxShadow: `inset 0 0 0 1px ${sw.border}`,
                }}
              />
              <span
                className={`
                  text-[11px] font-light text-center leading-tight
                  ${active ? 'text-[#c9a96e]' : theme.textMuted}
                `}
              >
                {DISPLAY_LABEL[name]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
