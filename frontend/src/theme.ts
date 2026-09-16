export const accents = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet'] as const;
export type Accent = typeof accents[number];
export interface Preferences {
  mode: 'light' | 'dark';
  accent: Accent;
  highContrast: boolean;
  progressHeight: number;
  disableDemos?: boolean;
}

export const preferenceKey = 'barre.appearance.v1';
export const palette: Record<Accent, { light: string; dark: string }> = {
  red: { light: '#b42332', dark: '#ff8a94' },
  orange: { light: '#a64500', dark: '#ffb078' },
  amber: { light: '#835600', dark: '#f5cc62' },
  green: { light: '#1d713d', dark: '#83dba2' },
  teal: { light: '#08756d', dark: '#69d9c9' },
  blue: { light: '#205eae', dark: '#94bcff' },
  violet: { light: '#7441b0', dark: '#c9a3ff' },
};

export function parsePreferences(raw: string | null, prefersDark = false): Preferences {
  const defaults: Preferences = {
    mode: prefersDark ? 'dark' : 'light', accent: 'teal', highContrast: false, progressHeight: 64, disableDemos: false,
  };
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object') return defaults;
    const stored = value as Record<string, unknown>;
    return {
      mode: stored.mode === 'dark' || stored.mode === 'light' ? stored.mode : defaults.mode,
      accent: accents.includes(stored.accent as Accent) ? stored.accent as Accent : defaults.accent,
      highContrast: stored.highContrast === true,
      disableDemos: stored.disableDemos === true,
      progressHeight: typeof stored.progressHeight === 'number' && Number.isFinite(stored.progressHeight)
        ? Math.min(120, Math.max(44, stored.progressHeight)) : defaults.progressHeight,
    };
  } catch {
    return defaults;
  }
}

export function readPreferences(): Preferences {
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  try {
    return parsePreferences(localStorage.getItem(preferenceKey), prefersDark);
  } catch {
    return parsePreferences(null, prefersDark);
  }
}

export function savePreferences(preferences: Preferences): boolean {
  try {
    localStorage.setItem(preferenceKey, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function themeColors(preferences: Preferences): { accent: string; onAccent: string } {
  const dark = preferences.mode === 'dark';
  return {
    accent: preferences.highContrast ? (dark ? '#ffffff' : '#000000') : palette[preferences.accent][preferences.mode],
    onAccent: dark ? '#141617' : '#ffffff',
  };
}

export function applyTheme(preferences: Preferences): void {
  const root = document.documentElement;
  root.dataset.mode = preferences.mode;
  root.dataset.contrast = String(preferences.highContrast);
  root.dataset.accent = preferences.accent;
  const colors = themeColors(preferences);
  root.style.setProperty('--accent', colors.accent);
  root.style.setProperty('--on-accent', colors.onAccent);
  root.style.setProperty('--progress-height', `${preferences.progressHeight}px`);
  root.style.colorScheme = preferences.mode;
}