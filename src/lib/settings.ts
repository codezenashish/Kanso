import { useSyncExternalStore } from 'react';

export const editorLayoutIds = ['comfortable', 'wide', 'full-width'] as const;
export const sidebarPanelIds = ['outline', 'properties', 'links', 'graph'] as const;
export const editorFontSizeRange = { min: 10, max: 32 };
export const editorLineHeightRange = { min: 1.2, max: 2.5 };
export const sidebarMinWidth = 220;
export const sidebarMaxWidth = 520;
export const leftSidebarWidthRange = { min: 220, max: 420 };

const themes = ['light', 'dark', 'system'] as const;
const editorViews = ['source', 'document'] as const;
const editorFonts = ['sans', 'serif', 'mono'] as const;

export type Settings = {
  theme: (typeof themes)[number];
  editorView: (typeof editorViews)[number];
  editorLayout: (typeof editorLayoutIds)[number];
  editorFont: (typeof editorFonts)[number];
  editorFontSize: number;
  editorLineHeight: number | null;
  codeBlockLineNumbers: boolean;
  codeBlockWordWrap: boolean;
  focusModeShortcut: 'mod-shift-f' | 'mod-shift-z' | 'off';
  sidebarPanel: (typeof sidebarPanelIds)[number];
  sidebarWidth: number;
  leftSidebarWidth: number;
  leftSidebarCollapsed: boolean;
};

export const defaultSettings: Readonly<Settings> = Object.freeze({
  theme: 'system',
  editorView: 'source',
  editorLayout: 'comfortable',
  editorFont: 'sans',
  editorFontSize: 16,
  editorLineHeight: null,
  codeBlockLineNumbers: false,
  codeBlockWordWrap: false,
  focusModeShortcut: 'mod-shift-f',
  sidebarPanel: 'outline',
  sidebarWidth: 256,
  leftSidebarWidth: 272,
  leftSidebarCollapsed: false,
});

const storageKey = 'kanso-settings';
const legacyKeys = ['theme', 'kanso-view', 'kanso-editor-layout', 'kanso-right-sidebar'] as const;

function choose<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

function boundedNumber<Fallback extends number | null>(value: unknown, fallback: Fallback, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function parseRecord(raw: string | null): Record<string, unknown> {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function validateSettings(value: Readonly<Record<string, unknown>>): Readonly<Settings> {
  return Object.freeze({
    theme: choose(value.theme, themes, defaultSettings.theme),
    editorView: choose(value.editorView, editorViews, defaultSettings.editorView),
    editorLayout: choose(value.editorLayout, editorLayoutIds, defaultSettings.editorLayout),
    editorFont: choose(value.editorFont, editorFonts, defaultSettings.editorFont),
    editorFontSize: boundedNumber(value.editorFontSize, defaultSettings.editorFontSize, editorFontSizeRange.min, editorFontSizeRange.max),
    editorLineHeight: boundedNumber(value.editorLineHeight, defaultSettings.editorLineHeight, editorLineHeightRange.min, editorLineHeightRange.max),
    codeBlockLineNumbers: typeof value.codeBlockLineNumbers === 'boolean' ? value.codeBlockLineNumbers : defaultSettings.codeBlockLineNumbers,
    codeBlockWordWrap: typeof value.codeBlockWordWrap === 'boolean' ? value.codeBlockWordWrap : defaultSettings.codeBlockWordWrap,
    focusModeShortcut: choose(value.focusModeShortcut, ['mod-shift-f', 'mod-shift-z', 'off'] as const, defaultSettings.focusModeShortcut),
    sidebarPanel: choose(value.sidebarPanel, sidebarPanelIds, defaultSettings.sidebarPanel),
    sidebarWidth: Math.round(boundedNumber(value.sidebarWidth, defaultSettings.sidebarWidth, sidebarMinWidth, sidebarMaxWidth)),
    leftSidebarWidth: Math.round(boundedNumber(
      value.leftSidebarWidth, defaultSettings.leftSidebarWidth, leftSidebarWidthRange.min, leftSidebarWidthRange.max,
    )),
    leftSidebarCollapsed: typeof value.leftSidebarCollapsed === 'boolean'
      ? value.leftSidebarCollapsed
      : defaultSettings.leftSidebarCollapsed,
  });
}

function persistSettings(settings: Readonly<Settings>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
    for (const key of legacyKeys) {
      if (localStorage.getItem(key) !== null) localStorage.removeItem(key);
    }
  } catch {
    // Keep the current session usable and preserve legacy values if saving fails.
  }
}

function loadSettings() {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) return validateSettings(parseRecord(stored));

    const legacy = legacyKeys.map((key) => localStorage.getItem(key));
    const [theme, editorView, editorLayout, sidebar] = legacy;
    const { panel: sidebarPanel, width: sidebarWidth } = parseRecord(sidebar ?? null);
    const migrated = validateSettings({ theme, editorView, editorLayout, sidebarPanel, sidebarWidth });
    if (legacy.some((value) => value !== null)) {
      persistSettings(migrated);
    }
    return migrated;
  } catch {
    return defaultSettings;
  }
}

let settings = loadSettings();
const listeners = new Set<() => void>();

function publishSettings(next: Readonly<Settings>) {
  settings = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSettings() {
  return settings;
}

export function updateSettings(patch: Partial<Settings>) {
  const next = validateSettings({ ...settings, ...patch });
  if (JSON.stringify(next) === JSON.stringify(settings)) return;

  persistSettings(next);
  publishSettings(next);
}

export function useSettings() {
  return useSyncExternalStore(subscribe, getSettings, () => defaultSettings);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    const next = validateSettings(parseRecord(event.newValue));
    if (JSON.stringify(next) !== JSON.stringify(settings)) publishSettings(next);
  });
}
