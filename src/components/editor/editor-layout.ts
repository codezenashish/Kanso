import { type Settings } from '@/lib/settings';

export const editorLayouts = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'wide', label: 'Wide' },
  { id: 'full-width', label: 'Full Width' },
] as const satisfies readonly { id: Settings['editorLayout']; label: string }[];

export type EditorLayout = Settings['editorLayout'];
