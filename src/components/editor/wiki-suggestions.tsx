import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WikiNote } from '@/lib/wiki-index';

export type WikiSuggestion = WikiNote & { target: string };
export type WikiMatch = { from: number; to: number; query: string; alias: string | null };
export type WikiMenu = {
  results: WikiSuggestion[];
  selected: number;
  left: number;
  top: number;
  bottom: number;
  choose: (choice: WikiSuggestion) => void;
};

export const wikiListId = 'wiki-note-suggestions';

export function matchWikiInput(prefix: string, cursor: number, suffix = ''): WikiMatch | null {
  const match = /(^|[^\\\[])\[\[([^\[\]|\r\n]*)(?:\|([^\[\]|\r\n]*))?$/.exec(prefix);
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
  useLayoutEffect(() => { selected.current?.scrollIntoView({ block: 'nearest' }); }, [menu.selected, menu.results]);
  const above = window.innerHeight - menu.bottom < 190 && menu.top > window.innerHeight - menu.bottom;
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
      {!menu.results.length && <p role="status" className="px-2 py-1.5 text-sm text-muted-foreground">No matching notes.</p>}
    </div>,
    document.body,
  );
}

export function textareaCaret(textarea: HTMLTextAreaElement, cursor: number) {
  const mirror = textarea.ownerDocument.createElement('div');
  const style = getComputedStyle(textarea);
  Object.assign(mirror.style, {
    position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
    boxSizing: 'border-box', width: `${textarea.clientWidth}px`,
    whiteSpace: 'pre-wrap', overflowWrap: 'break-word', font: style.font,
    letterSpacing: style.letterSpacing, tabSize: style.tabSize, padding: style.padding,
  });
  const bounds = textarea.getBoundingClientRect();
  mirror.style.top = `${bounds.top - textarea.scrollTop}px`;
  mirror.style.left = `${bounds.left - textarea.scrollLeft}px`;
  mirror.textContent = textarea.value.slice(0, cursor);
  const marker = textarea.ownerDocument.createElement('span');
  marker.textContent = textarea.value.slice(cursor) || '\u200b';
  mirror.append(marker);
  textarea.ownerDocument.body.append(mirror);
  const caret = marker.getClientRects()[0] ?? marker.getBoundingClientRect();
  mirror.remove();
  return caret;
}
