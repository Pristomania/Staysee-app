import type { ThemeName } from '../context/ThemeContext';

/** Palette for theme picker mini-previews (matches ThemeContext). */
export interface ThemePreviewPalette {
  bg: string;
  surface: string;
  userBubble: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  border: string;
}

export const THEME_PREVIEW: Record<ThemeName, ThemePreviewPalette> = {
  deep: {
    bg: '#0e1117',
    surface: '#161c27',
    userBubble: '#1d2535',
    textPrimary: '#ece9e3',
    textSecondary: '#8a9aaa',
    accent: '#c9a96e',
    border: '#2a3545',
  },
  light: {
    bg: '#f7f4ef',
    surface: '#eeeae3',
    userBubble: '#e5e0d8',
    textPrimary: '#1e1a16',
    textSecondary: '#6b6058',
    accent: '#8a7355',
    border: '#d8d0c4',
  },
  mist: {
    bg: '#1a1e24',
    surface: '#21272f',
    userBubble: '#282f38',
    textPrimary: '#dde0e4',
    textSecondary: '#7d8a96',
    accent: '#9aacba',
    border: '#2e3640',
  },
};
