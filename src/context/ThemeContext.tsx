import React, { createContext, useContext, useState, useEffect } from 'react';

export type ThemeName = 'deep' | 'light' | 'mist';

export interface Theme {
  name: ThemeName;
  label: string;
  description: string;

  // Backgrounds
  bg: string;
  bgSubtle: string;
  surface: string;
  surfaceHover: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textMuted: string;

  // Borders
  border: string;
  borderHover: string;

  // Input
  inputBg: string;
  inputBorder: string;
  inputBorderFocus: string;
  inputText: string;
  inputPlaceholder: string;

  // Button
  btnBg: string;
  btnBgHover: string;
  btnBorder: string;
  btnBorderHover: string;
  btnText: string;

  // Message bubbles
  msgUserBg: string;
  msgUserText: string;
  msgAiText: string;

  // Divider
  divider: string;

  // Spinner
  spinnerBorder: string;
  spinnerTop: string;

  // Raw hex for JS gradient usage
  bgHex: string;
}

const themes: Record<ThemeName, Theme> = {
  deep: {
    name: 'deep',
    label: 'Глубокая ночь',
    description: 'Тёмный морской. Тихо и безопасно.',

    bg: 'bg-[#0e1117]',
    bgSubtle: 'bg-[#0e1117]',
    surface: 'bg-[#161c27]',
    surfaceHover: 'hover:bg-[#1d2535]',

    textPrimary: 'text-[#ece9e3]',
    textSecondary: 'text-[#8a9aaa]',
    textMuted: 'text-[#5a6878]',

    border: 'border-[#2a3545]',
    borderHover: 'hover:border-[#3a4a5a]',

    inputBg: 'bg-[#141a24]',
    inputBorder: 'border-[#2a3545]',
    inputBorderFocus: 'focus:border-[#c9a96e]/60',
    inputText: 'text-[#ece9e3]',
    inputPlaceholder: 'placeholder-[#4a5a6a]',

    btnBg: 'bg-[#161c27]',
    btnBgHover: 'hover:bg-[#1d2535]',
    btnBorder: 'border-[#2a3545]',
    btnBorderHover: 'hover:border-[#c9a96e]/40',
    btnText: 'text-[#c9a96e]',

    msgUserBg: 'bg-[#1d2535]',
    msgUserText: 'text-[#ece9e3]',
    msgAiText: 'text-[#8a9aaa]',

    divider: 'bg-[#2a3545]',

    spinnerBorder: 'border-[#2a3545]',
    spinnerTop: 'border-t-[#c9a96e]/70',
    bgHex: '#0e1117',
  },

  light: {
    name: 'light',
    label: 'Тёплая тишина',
    description: 'Тёплые молочные тона. Спокойно и уютно.',

    bg: 'bg-[#f7f4ef]',
    bgSubtle: 'bg-[#f7f4ef]',
    surface: 'bg-[#eeeae3]',
    surfaceHover: 'hover:bg-[#e5e0d8]',

    textPrimary: 'text-[#1e1a16]',
    textSecondary: 'text-[#6b6058]',
    textMuted: 'text-[#a09080]',

    border: 'border-[#d8d0c4]',
    borderHover: 'hover:border-[#c0b4a4]',

    inputBg: 'bg-white',
    inputBorder: 'border-[#ccc4b8]',
    inputBorderFocus: 'focus:border-[#6b6058]',
    inputText: 'text-[#1e1a16]',
    inputPlaceholder: 'placeholder-[#a09080]',

    btnBg: 'bg-[#eeeae3]',
    btnBgHover: 'hover:bg-[#e5e0d8]',
    btnBorder: 'border-[#ccc4b8]',
    btnBorderHover: 'hover:border-[#a09080]',
    btnText: 'text-[#1e1a16]',

    msgUserBg: 'bg-[#e5e0d8]',
    msgUserText: 'text-[rgba(30,26,22,0.88)]',
    msgAiText: 'text-[#6b6058]',

    divider: 'bg-[#d8d0c4]',

    spinnerBorder: 'border-[#d8d0c4]',
    spinnerTop: 'border-t-[#6b6058]',
    bgHex: '#f7f4ef',
  },

  mist: {
    name: 'mist',
    label: 'Туман',
    description: 'Серо-синий туман. Тихое созерцание.',

    bg: 'bg-[#1a1e24]',
    bgSubtle: 'bg-[#1a1e24]',
    surface: 'bg-[#21272f]',
    surfaceHover: 'hover:bg-[#282f38]',

    textPrimary: 'text-[#dde0e4]',
    textSecondary: 'text-[#7d8a96]',
    textMuted: 'text-[#4e5a66]',

    border: 'border-[#2e3640]',
    borderHover: 'hover:border-[#3d4a56]',

    inputBg: 'bg-[#1e2430]',
    inputBorder: 'border-[#2e3640]',
    inputBorderFocus: 'focus:border-[#7d8a96]/60',
    inputText: 'text-[#dde0e4]',
    inputPlaceholder: 'placeholder-[#4e5a66]',

    btnBg: 'bg-[#21272f]',
    btnBgHover: 'hover:bg-[#282f38]',
    btnBorder: 'border-[#2e3640]',
    btnBorderHover: 'hover:border-[#5a6878]',
    btnText: 'text-[#9aacba]',

    msgUserBg: 'bg-[#282f38]',
    msgUserText: 'text-[#dde0e4]',
    msgAiText: 'text-[#7d8a96]',

    divider: 'bg-[#2e3640]',

    spinnerBorder: 'border-[#2e3640]',
    spinnerTop: 'border-t-[#7d8a96]',
    bgHex: '#1a1e24',
  },
};

interface ThemeContextType {
  theme: Theme;
  themeName: ThemeName;
  setTheme: (name: ThemeName) => void;
  allThemes: typeof themes;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeName, setThemeName] = useState<ThemeName>(() => {
    return (localStorage.getItem('staysee-theme') as ThemeName) || 'deep';
  });

  const setTheme = (name: ThemeName) => {
    setThemeName(name);
    localStorage.setItem('staysee-theme', name);
  };

  useEffect(() => {
    document.body.className = themes[themeName].bg.replace('bg-', 'bg-');
  }, [themeName]);

  return (
    <ThemeContext.Provider value={{ theme: themes[themeName], themeName, setTheme, allThemes: themes }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
