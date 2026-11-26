import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FilePlus2, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WikiNote } from '@/lib/wiki-index';

export type WikiSuggestion = WikiNote & { target: string };
export type WikiCreateSuggestion = {
  target: string;
  name: string;
  path: string;
};
type WikiMatch = { from: number; to: number; query: string; alias: string | null };
export type WikiMenu = {
  results: WikiSuggestion[];
  create: WikiCreateSuggestion | null;
  selected: number;
  left: number;
  top: number;
  bottom: number;
  choose: (choice: WikiSuggestion) => void;
  chooseCreate: () => void;
};

export const wikiListId = 'wiki-note-suggestions';
export const wikiCreateOptionId = `${wikiListId}-create`;

export function wikiMenuOptionCount(menu: Pick<WikiMenu, 'results' | 'create'>) {
  return menu.results.length + (menu.create ? 1 : 0);
}

export function wikiActiveDescendantId(menu: Pick<WikiMenu, 'results' | 'create' | 'selected'>) {
  if (menu.selected < menu.results.length) return `${wikiListId}-${menu.selected}`;
  if (menu.create && menu.selected === menu.results.length) return wikiCreateOptionId;
  return null;
}

export function matchWikiInput(prefix: string, cursor: number, suffix = ''): WikiMatch | null {
  const match = /(^|[^\\\[])\[\[([^\[\]|\\\r\n]*)(?:\\?\|([^\[\]|\r\n]*))?$/.exec(prefix);
  if (!match) return null;
  const from = cursor - match[0].length + match[1].length;
  return { from, to: cursor + (suffix.startsWith(']]') ? 2 : 0), query: match[2], alias: match[3] ?? null };
}

export function filterWikiNotes(notes: WikiSuggestion[], query: string) {
  const value = query.trim().normalize('NFC').toLowerCase();
  return notes.filter((note) => note.name.normalize('NFC').toLowerCase().includes(value)
    || note.path.normalize('NFC').toLowerCase().includes(value)).slice(0, 30);
}

export function WikiSuggestionMenu({ menu }: { menu: WikiMenu }) {
  const selected = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { selected.current?.scrollIntoView({ block: 'nearest' }); }, [menu.selected, menu.results, menu.create]);
  const above = window.innerHeight - menu.bottom < 190 && menu.top > window.innerHeight - menu.bottom;
  const createIndex = menu.results.length;
  const createSelected = Boolean(menu.create) && menu.selected === createIndex;

  return createPortal(
    <div
      id={wikiListId}
      role="listbox"
      aria-label="Link to a note"
      className="fixed z-30 w-64 max-w-[calc(100dvw-0.5rem)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{
        left: Math.max(4, Math.min(menu.left, window.innerWidth - 260)),
        [above ? 'bottom' : 'top']: above ? window.innerHeight - menu.top + 4 : menu.bottom + 4,
        maxHeight: Math.max(0, Math.min(240, (above ? menu.top : window.innerHeight - menu.bottom) - 8)),
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {menu.results.map((note, index) => (
        <div
          key={note.id}
          id={`${wikiListId}-${index}`}
          role="option"
          aria-selected={index === menu.selected}
          ref={index === menu.selected ? selected : undefined}
          className={cn('group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground', index === menu.selected && 'bg-accent text-accent-foreground')}
          onClick={() => menu.choose(note)}
        >
          <FileText aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0">
            <span className="block wrap-anywhere">{note.name}</span>
            {note.target !== note.name && <span className="block wrap-anywhere text-xs text-muted-foreground group-hover:text-accent-foreground group-aria-selected:text-accent-foreground">{note.path}</span>}
          </span>
        </div>
      ))}
      {menu.create && (
        <div
          id={wikiCreateOptionId}
          role="option"
          aria-selected={createSelected}
          ref={createSelected ? selected : undefined}
          className={cn(
            'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground',
            menu.results.length > 0 && 'mt-1 border-t border-border pt-2',
            createSelected && 'bg-accent text-accent-foreground',
          )}
          onClick={() => menu.chooseCreate()}
        >
          <FilePlus2 aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <span className="min-w-0">
            <span className="block font-medium wrap-anywhere">Create note</span>
            <span className="block text-xs text-muted-foreground wrap-anywhere group-hover:text-accent-foreground group-aria-selected:text-accent-foreground">{menu.create.path}</span>
          </span>
        </div>
      )}
      {!menu.results.length && !menu.create && (
        <p role="status" className="px-2 py-1.5 text-sm text-muted-foreground">No matching notes.</p>
      )}
    </div>,
    document.body,
  );
}
