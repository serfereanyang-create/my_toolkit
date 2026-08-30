export type AppTheme = 'cool' | 'paper' | 'dark';
export type ActiveDrawer = 'quality' | 'account' | 'review' | null;
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

export type ThemeTokens = {
  appBg: string;
  sidebarBg: string;
  canvasBg: string;
  elevatedBg: string;
  inputBg: string;
  border: string;
  accent: string;
  textPrimary: string;
  textSecondary: string;
  selectedBg: string;
  shadow: string;
  antPrimary: string;
  antBgBase: string;
  antTextBase: string;
  isDark: boolean;
};

const THEMES: Record<AppTheme, ThemeTokens> = {
  cool: {
    appBg: '#e8eef6',
    sidebarBg: '#dce6f2',
    canvasBg: '#ffffff',
    elevatedBg: '#f7faff',
    inputBg: '#f4f8fc',
    border: '#a8bad0',
    accent: '#2454d6',
    textPrimary: '#152033',
    textSecondary: '#5b6b80',
    selectedBg: '#d4e4ff',
    shadow: '0 10px 28px rgba(28, 58, 110, 0.12)',
    antPrimary: '#2454d6',
    antBgBase: '#e8eef6',
    antTextBase: '#152033',
    isDark: false,
  },
  paper: {
    appBg: '#f1ebe2',
    sidebarBg: '#e5dccf',
    canvasBg: '#fff8ed',
    elevatedBg: '#fffdf8',
    inputBg: '#faf3e8',
    border: '#c4b090',
    accent: '#8a5a2b',
    textPrimary: '#2a241c',
    textSecondary: '#6d6154',
    selectedBg: '#efdfc4',
    shadow: '0 10px 26px rgba(110, 72, 28, 0.12)',
    antPrimary: '#8a5a2b',
    antBgBase: '#f1ebe2',
    antTextBase: '#2a241c',
    isDark: false,
  },
  dark: {
    appBg: '#0c111a',
    sidebarBg: '#080c13',
    canvasBg: '#151a24',
    elevatedBg: '#1c2330',
    inputBg: '#1a212d',
    border: '#455166',
    accent: '#7aa2ff',
    textPrimary: '#e8edf7',
    textSecondary: '#a7b2c5',
    selectedBg: '#1e2d45',
    shadow: '0 14px 34px rgba(0, 0, 0, 0.48)',
    antPrimary: '#7aa2ff',
    antBgBase: '#0c111a',
    antTextBase: '#e8edf7',
    isDark: true,
  },
};

export function getThemeTokens(theme: AppTheme): ThemeTokens {
  return THEMES[theme] ?? THEMES.cool;
}

export function nextActiveDrawer(current: ActiveDrawer, target: Exclude<ActiveDrawer, null>): ActiveDrawer {
  return current === target ? null : target;
}

export function nextSaveStatus(_current: SaveStatus, event: 'start' | 'success' | 'error' | 'retry'): SaveStatus {
  if (event === 'start' || event === 'retry') return 'saving';
  if (event === 'success') return 'saved';
  return 'failed';
}

export function resolveSessionStatus(input: { loading: boolean; user: { id: string } | null }): SessionStatus {
  if (input.loading) return 'loading';
  return input.user ? 'authenticated' : 'anonymous';
}
