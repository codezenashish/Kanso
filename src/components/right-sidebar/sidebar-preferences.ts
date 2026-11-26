import { Braces, ListTree, Network, Workflow } from 'lucide-react';
import { sidebarMaxWidth, sidebarMinWidth, updateSettings, useSettings, type Settings } from '@/lib/settings';

export { sidebarMaxWidth, sidebarMinWidth };

export const sidebarPanels = [
  { id: 'outline', title: 'Outline', Icon: ListTree },
  { id: 'properties', title: 'Properties', Icon: Braces },
  { id: 'links', title: 'Connections', Icon: Workflow },
  { id: 'graph', title: 'Graph', Icon: Network },
] as const satisfies readonly { id: Settings['sidebarPanel']; title: string; Icon: typeof ListTree }[];

export function clampSidebarWidth(width: number, min = sidebarMinWidth, max = sidebarMaxWidth) {
  return Math.round(Math.max(min, Math.min(max, width)));
}

export function useSidebarPreferences() {
  const { sidebarPanel, sidebarWidth } = useSettings();
  return {
    preferences: { panel: sidebarPanel, width: sidebarWidth },
    setPanel(panel: Settings['sidebarPanel']) { updateSettings({ sidebarPanel: panel }); },
    setWidth(width: number) { updateSettings({ sidebarWidth: width }); },
  };
}
