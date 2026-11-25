import { Braces, ListTree, Network, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';

export const sidebarPanels = [
  { id: 'outline', title: 'Outline', Icon: ListTree },
  { id: 'properties', title: 'Properties', Icon: Braces },
  { id: 'links', title: 'Connections', Icon: Workflow },
  { id: 'graph', title: 'Graph', Icon: Network },
] as const;

const storageKey = 'kanso-right-sidebar';
export const sidebarMinWidth = 220;
export const sidebarMaxWidth = 520;
type SidebarPanel = (typeof sidebarPanels)[number]['id'];
type SidebarPreferences = { panel: SidebarPanel; width: number };
const defaults: SidebarPreferences = { panel: 'outline', width: 256 };

export function clampSidebarWidth(width: number, min = sidebarMinWidth, max = sidebarMaxWidth) {
  return Math.round(Math.max(min, Math.min(max, width)));
}

function readSidebarPreferences(): SidebarPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<SidebarPreferences> | null;
    const panel = sidebarPanels.find(({ id }) => id === stored?.panel)?.id;
    const width = stored?.width;
    return {
      panel: panel ?? defaults.panel,
      width: typeof width === 'number' && Number.isFinite(width) ? clampSidebarWidth(width) : defaults.width,
    };
  } catch {
    return defaults;
  }
}

export function useSidebarPreferences() {
  const [preferences, setPreferences] = useState(readSidebarPreferences);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(preferences));
    } catch {
      // Preferences still apply during this session when storage is unavailable.
    }
  }, [preferences]);

  return {
    preferences,
    setPanel(panel: SidebarPanel) { setPreferences((previous) => previous.panel === panel ? previous : { ...previous, panel }); },
    setWidth(width: number) {
      const preferred = clampSidebarWidth(width);
      setPreferences((previous) => previous.width === preferred ? previous : { ...previous, width: preferred });
    },
  };
}
