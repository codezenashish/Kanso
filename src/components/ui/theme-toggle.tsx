import * as React from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { Select } from "@/components/ui/select";
import { updateSettings, useSettings, type Settings } from "@/lib/settings";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Types & Constants                                                          */
/* -------------------------------------------------------------------------- */

type Theme = Settings["theme"];
type ResolvedTheme = "light" | "dark";

interface ThemeOption {
  value: Theme;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

/* -------------------------------------------------------------------------- */
/* Snappy Transition Helper                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Temporarily disables CSS transitions across all DOM elements during theme
 * changes to ensure instant, snappy visual switching without duration lag.
 */
function disableTransitions() {
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

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    return getSystemTheme();
  }
  return theme;
}

function applyTheme(theme: Theme) {
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

function setTheme(theme: Theme) {
  updateSettings({ theme });
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useSettings();
  const [resolvedTheme, setResolvedTheme] = React.useState(() => resolveTheme(theme));

  const toggleTheme = React.useCallback(() => {
    setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");
  }, [theme]);

  React.useLayoutEffect(() => {
    const syncTheme = () => {
      applyTheme(theme);
      setResolvedTheme(resolveTheme(theme));
    };

    syncTheme();
    if (theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", syncTheme);
    return () => mediaQuery.removeEventListener("change", syncTheme);
  }, [theme]);

  const value = React.useMemo(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, toggleTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (!context) throw new Error("useTheme requires ThemeProvider");
  return context;
}

/* -------------------------------------------------------------------------- */
/* ThemeToggle UI Component                                                   */
/* -------------------------------------------------------------------------- */

interface ThemeToggleProps {
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

  /* --- Variant 2: Dropdown Select --- */
  if (effectiveVariant === "dropdown") {
    return (
      <Select
        value={theme}
        options={THEME_OPTIONS.map((option) => ({ value: option.value, label: option.label, icon: option.icon }))}
        onValueChange={(value) => setTheme(value as Theme)}
        aria-label="Theme"
        className={cn(
          "rounded-lg bg-card text-card-foreground",
          size === "xs" && "h-6 px-2 text-[11px]",
          size === "sm" && "h-7 px-2.5 text-xs",
          size === "default" && "h-8 px-3 text-sm",
          className,
        )}
        triggerClassName="border-border shadow-2xs"
      />
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
              "relative flex items-center justify-center rounded-md text-xs motion-safe:transition-colors duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50",
              size === "xs" && "size-6",
              size === "sm" && "size-7",
              size === "default" && "size-8",
              showLabel && "px-2 w-auto gap-1.5",
              isSelected
                ? "bg-background text-foreground shadow-2xs font-medium"
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
