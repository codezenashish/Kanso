import * as React from "react";
import { Sun, Moon, Monitor, Check } from "lucide-react";
import { cn } from "../../lib/utils";

/* -------------------------------------------------------------------------- */
/* Types & Constants                                                          */
/* -------------------------------------------------------------------------- */

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface ThemeOption {
  value: Theme;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

export interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = "theme";

/* -------------------------------------------------------------------------- */
/* Snappy Transition Helper                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Temporarily disables CSS transitions across all DOM elements during theme
 * changes to ensure instant, snappy visual switching without duration lag.
 */
export function disableTransitions() {
  if (typeof document === "undefined") return () => {};

  const css = document.createElement("style");
  css.setAttribute("type", "text/css");
  css.appendChild(
    document.createTextNode(
      `*, *::before, *::after {
        -webkit-transition: none !important;
        -moz-transition: none !important;
        -o-transition: none !important;
        -ms-transition: none !important;
        transition: none !important;
      }`
    )
  );
  document.head.appendChild(css);

  return () => {
    // Force a synchronous reflow so classes apply with 0ms transition
    void window.getComputedStyle(document.body).opacity;

    // Remove in subsequent frame so normal interactive transitions resume
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (css.parentNode) {
          document.head.removeChild(css);
        }
      });
    });
  };
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    return getSystemTheme();
  }
  return theme;
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;

  const resolved = resolveTheme(theme);
  const root = document.documentElement;

  const cleanup = disableTransitions();

  if (resolved === "dark") {
    root.classList.add("dark");
    root.classList.remove("light");
  } else {
    root.classList.remove("dark");
    root.classList.add("light");
  }

  root.style.colorScheme = resolved;

  cleanup();
}

/* -------------------------------------------------------------------------- */
/* Context & Provider                                                         */
/* -------------------------------------------------------------------------- */

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

export interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = STORAGE_KEY,
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    if (typeof window === "undefined") return defaultTheme;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === "light" || stored === "dark" || stored === "system") {
        return stored;
      }
    } catch (_) {}
    return defaultTheme;
  });

  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>(() =>
    resolveTheme(theme)
  );

  const setTheme = React.useCallback(
    (newTheme: Theme) => {
      setThemeState(newTheme);
      try {
        localStorage.setItem(storageKey, newTheme);
      } catch (_) {}
      applyTheme(newTheme);
      setResolvedTheme(resolveTheme(newTheme));
    },
    [storageKey]
  );

  const toggleTheme = React.useCallback(() => {
    setTheme(
      theme === "light" ? "dark" : theme === "dark" ? "system" : "light"
    );
  }, [theme, setTheme]);

  // Handle system preference changes & storage sync across tabs
  React.useEffect(() => {
    applyTheme(theme);
    setResolvedTheme(resolveTheme(theme));

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleMediaChange = () => {
      if (theme === "system") {
        applyTheme("system");
        setResolvedTheme(getSystemTheme());
      }
    };

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === storageKey && e.newValue) {
        const val = e.newValue as Theme;
        if (val === "light" || val === "dark" || val === "system") {
          setThemeState(val);
          applyTheme(val);
          setResolvedTheme(resolveTheme(val));
        }
      }
    };

    mediaQuery.addEventListener("change", handleMediaChange);
    window.addEventListener("storage", handleStorageChange);

    return () => {
      mediaQuery.removeEventListener("change", handleMediaChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [theme, storageKey]);

  const value = React.useMemo(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/* -------------------------------------------------------------------------- */
/* useTheme Hook (Works with or without ThemeProvider)                       */
/* -------------------------------------------------------------------------- */

export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);

  // Fallback standalone implementation if not wrapped by ThemeProvider
  const [localTheme, setLocalTheme] = React.useState<Theme>(() => {
    if (typeof window === "undefined") return "system";
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") {
        return stored;
      }
    } catch (_) {}
    return "system";
  });

  const [localResolved, setLocalResolved] = React.useState<ResolvedTheme>(() =>
    resolveTheme(localTheme)
  );

  const setStandaloneTheme = React.useCallback((newTheme: Theme) => {
    setLocalTheme(newTheme);
    try {
      localStorage.setItem(STORAGE_KEY, newTheme);
    } catch (_) {}
    applyTheme(newTheme);
    setLocalResolved(resolveTheme(newTheme));
  }, []);

  const toggleStandaloneTheme = React.useCallback(() => {
    setStandaloneTheme(
      localTheme === "light" ? "dark" : localTheme === "dark" ? "system" : "light"
    );
  }, [localTheme, setStandaloneTheme]);

  if (context) {
    return context;
  }

  return {
    theme: localTheme,
    resolvedTheme: localResolved,
    setTheme: setStandaloneTheme,
    toggleTheme: toggleStandaloneTheme,
  };
}

/* -------------------------------------------------------------------------- */
/* ThemeToggle UI Component                                                   */
/* -------------------------------------------------------------------------- */

export interface ThemeToggleProps {
  /**
   * Display mode:
   * - "segmented": 3 buttons side-by-side (Light, System, Dark)
   * - "cycle": A single icon button that cycles through themes on click
   * - "dropdown": A button with a popover menu to pick Light, Dark, or System
   */
  variant?: "segmented" | "cycle" | "dropdown";
  /** Collapsed mode (defaults to cycle variant when true) */
  collapsed?: boolean;
  /** Size variant */
  size?: "xs" | "sm" | "default";
  /** Custom wrapper class */
  className?: string;
  /** Whether to show a text label */
  showLabel?: boolean;
}

export function ThemeToggle({
  variant,
  collapsed = false,
  size = "sm",
  className,
  showLabel = false,
}: ThemeToggleProps) {
  const { theme, setTheme, toggleTheme } = useTheme();
  const [dropdownOpen, setDropdownOpen] = React.useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  // Close dropdown on outside click or Escape
  React.useEffect(() => {
    if (!dropdownOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [dropdownOpen]);

  // Determine active icon for single-button / cycle displays
  const CurrentIcon =
    theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;

  const nextThemeMap: Record<Theme, Theme> = {
    light: "dark",
    dark: "system",
    system: "light",
  };

  const nextTheme = nextThemeMap[theme];
  const nextThemeLabel =
    nextTheme.charAt(0).toUpperCase() + nextTheme.slice(1);

  // If collapsed is explicitly true, default to compact cycle variant
  const effectiveVariant = variant ?? (collapsed ? "cycle" : "segmented");

  /* --- Variant 1: Cycle Button (Ideal for Collapsed Sidebar / Compact Header) --- */
  if (effectiveVariant === "cycle") {
    return (
      <button
        type="button"
        onClick={toggleTheme}
        title={`Theme: ${theme.charAt(0).toUpperCase() + theme.slice(1)} (Click to switch to ${nextThemeLabel})`}
        aria-label={`Current theme is ${theme}. Switch to ${nextThemeLabel}`}
        className={cn(
          "inline-flex items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors duration-150 outline-none select-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
          size === "xs" && "size-6",
          size === "sm" && "size-7",
          size === "default" && "size-8",
          className
        )}
      >
        <CurrentIcon className={size === "xs" ? "size-3" : "size-3.5"} />
      </button>
    );
  }

  /* --- Variant 2: Dropdown Menu --- */
  if (effectiveVariant === "dropdown") {
    return (
      <div className={cn("relative inline-block text-left", className)} ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setDropdownOpen((prev) => !prev)}
          aria-expanded={dropdownOpen}
          aria-haspopup="true"
          title={`Theme: ${theme.charAt(0).toUpperCase() + theme.slice(1)}`}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-2xs transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
            size === "xs" && "h-6 px-2 text-[11px]",
            size === "sm" && "h-7 px-2.5 text-xs",
            size === "default" && "h-8 px-3 text-sm"
          )}
        >
          <CurrentIcon className="size-3.5 text-muted-foreground" />
          {showLabel && (
            <span className="capitalize">{theme}</span>
          )}
        </button>

        {dropdownOpen && (
          <div className="absolute right-0 bottom-full mb-1 sm:bottom-auto sm:top-full sm:mt-1 z-50 min-w-32 rounded-lg border border-border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95">
            {THEME_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const isSelected = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setTheme(opt.value);
                    setDropdownOpen(false);
                  }}
                  className={cn(
                    "w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs transition-colors duration-150 select-none outline-none",
                    isSelected
                      ? "bg-accent text-accent-foreground font-semibold"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Icon className="size-3.5" />
                    <span>{opt.label}</span>
                  </span>
                  {isSelected && <Check className="size-3 text-foreground" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  /* --- Variant 3: Segmented Pill Control (Default for Expanded Sidebar / Toolbars) --- */
  return (
    <div
      role="group"
      aria-label="Theme selection"
      className={cn(
        "inline-flex items-center rounded-lg border border-sidebar-border/60 bg-sidebar-accent/30 p-0.5",
        className
      )}
    >
      {THEME_OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const isSelected = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setTheme(opt.value)}
            title={`${opt.label} theme`}
            aria-pressed={isSelected}
            aria-label={`Switch to ${opt.label} theme`}
            className={cn(
              "relative flex items-center justify-center rounded-md text-xs transition-colors duration-150 outline-none select-none",
              size === "xs" && "size-6",
              size === "sm" && "size-7",
              size === "default" && "size-8",
              showLabel && "px-2 w-auto gap-1.5",
              isSelected
                ? "bg-background text-foreground shadow-2xs font-semibold"
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
            )}
          >
            <Icon className={size === "default" ? "size-4" : "size-3.5"} />
            {showLabel && <span>{opt.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

export default ThemeToggle;
