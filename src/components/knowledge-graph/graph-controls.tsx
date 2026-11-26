import { useId, useState } from 'react';
import { cn } from '@/lib/utils';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Crosshair, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { menuItemClass, menuPopupClass, menuPositionerClass } from '@/components/ui/menu-styles';
import type { NoteGraph, GraphFilters, GraphMode } from './graph-data';

export type GraphTagOption = {
  value: string;
  label: string;
};

type GraphControlsProps = {
  filters: GraphFilters;
  onChange: (filters: GraphFilters) => void;
  folders: string[];
  tags: GraphTagOption[];
  mode: GraphMode;
};

const fieldClass = 'min-h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring';


function openRowContextMenu(event: React.KeyboardEvent<HTMLButtonElement>) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + Math.min(rect.width / 2, 48),
    clientY: rect.bottom,
  }));
}

export function GraphControls({ filters, onChange, folders, tags, mode }: GraphControlsProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterId = useId();
  return (
    <div className="grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-1.5">
      <label className="relative min-w-0">
        <Search aria-hidden="true" className="pointer-events-none absolute start-2 top-1.5 size-3.5 text-muted-foreground" />
        <input
          type="search" aria-label="Search graph notes" placeholder="Search notes"
          className={fieldClass + ' ps-7'}
          value={filters.query} onChange={(event) => onChange({ ...filters, query: event.target.value })}
        />
      </label>
      <Button variant="outline" size="sm" aria-expanded={filtersOpen} aria-controls={filterId}
        onClick={() => setFiltersOpen((open) => !open)}>
        Filters
      </Button>
      <div id={filterId} hidden={!filtersOpen}
        className="col-span-full grid min-w-0 gap-2 rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground">
        <label className="grid min-w-0 gap-0.5">
          Folder
          <Select className={fieldClass} value={filters.folder} options={[
            { value: '', label: 'All folders' }, { value: '/', label: 'Workspace root' }, ...folders.map((folder) => ({ value: folder, label: folder })),
          ]} onValueChange={(folder) => onChange({ ...filters, folder })} />
        </label>
        <label className="grid min-w-0 gap-0.5">
          Tag
          <Select className={fieldClass} value={filters.tag} options={[{ value: '', label: 'All tags' }, ...tags.map((tag) => ({ value: tag.value, label: tag.label }))]}
            onValueChange={(tag) => onChange({ ...filters, tag })} />
        </label>
        {mode === 'local' && (
          <label className="grid min-w-0 gap-0.5">
            Connection depth
            <Select className={fieldClass} value={String(filters.depth)} options={[1, 2, 3, 4, 5].map((depth) => ({ value: String(depth), label: String(depth) }))}
              onValueChange={(depth) => onChange({ ...filters, depth: Number(depth) })} />
          </label>
        )}
        {mode === 'global' && <label className="flex min-h-6 items-center gap-1.5">
          <input type="checkbox" className="accent-primary" checked={filters.showOrphans}
            onChange={(event) => onChange({ ...filters, showOrphans: event.target.checked })} />
          Show orphan notes
        </label>}
      </div>
    </div>
  );
}

export function GraphNoteList({ graph, activeId, focusId, searching, onOpen, onFocusLocal }: {
  graph: NoteGraph;
  activeId: string;
  focusId?: string;
  searching: boolean;
  onOpen: (id: string) => void;
  onFocusLocal: (id: string) => void;
}) {
  const [limit, setLimit] = useState(40);
  const currentId = focusId || activeId;
  return (
    <details className="shrink-0">
      <summary className="cursor-pointer rounded-sm px-1 py-0.5 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <span aria-live="polite" aria-busy={searching}>{graph.nodes.length} {graph.nodes.length === 1 ? 'note' : 'notes'} · {graph.links.length} {graph.links.length === 1 ? 'connection' : 'connections'}</span>
      </summary>
      {graph.nodes.length > 0 ? (
        <ul aria-label="Notes in graph" className="max-h-32 overflow-auto rounded-md border border-border bg-background p-0.5">
          {graph.nodes.slice(0, limit).map((note) => (
            <li key={note.id} className="group flex items-center gap-0.5">
              <ContextMenu.Root>
                <ContextMenu.Trigger
                  render={
                    <button
                      type="button"
                      aria-current={note.id === currentId ? 'page' : undefined}
                      title={`Open ${note.path}`}
                      onClick={() => onOpen(note.id)}
                      onKeyDown={openRowContextMenu}
                      className="min-w-0 flex-1 truncate rounded-sm px-1.5 py-1 text-start text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-current:font-semibold"
                    />
                  }
                >
                  {note.name} <span className="text-muted-foreground">{note.path}</span>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Positioner className={menuPositionerClass}>
                    <ContextMenu.Popup
                      aria-label={`Graph actions for ${note.name}`}
                      className={cn(menuPopupClass, "w-40")}
                    >
                      <ContextMenu.Item className={menuItemClass} onClick={() => onOpen(note.id)}>
                        Open note
                      </ContextMenu.Item>
                      <ContextMenu.Item className={menuItemClass} onClick={() => onFocusLocal(note.id)}>
                        Focus local graph
                      </ContextMenu.Item>
                    </ContextMenu.Popup>
                  </ContextMenu.Positioner>
                </ContextMenu.Portal>
              </ContextMenu.Root>
              <button
                type="button"
                aria-label={`Focus local graph on ${note.name}`}
                title={`Focus local graph on ${note.name}`}
                onClick={() => onFocusLocal(note.id)}
                className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                <Crosshair aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
          {graph.nodes.length > limit && (
            <li><Button size="xs" variant="ghost" onClick={() => setLimit((current) => current + 40)}>Show more notes</Button></li>
          )}
        </ul>
      ) : (
        <p role="status" className="px-2 py-1 text-xs text-muted-foreground">No matching notes.</p>
      )}
    </details>
  );
}
