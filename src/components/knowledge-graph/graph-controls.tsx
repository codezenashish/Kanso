import { useId, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { NoteGraph, GraphFilters, GraphMode } from './graph-data';

type GraphControlsProps = {
  filters: GraphFilters;
  onChange: (filters: GraphFilters) => void;
  folders: string[];
  mode: GraphMode;
};

const fieldClass = 'min-h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring';

export function GraphControls({ filters, onChange, folders, mode }: GraphControlsProps) {
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
          <select className={fieldClass} value={filters.folder} onChange={(event) => onChange({ ...filters, folder: event.target.value })}>
            <option value="">All folders</option>
            <option value="/">Workspace root</option>
            {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
          </select>
        </label>
        {mode === 'local' && (
          <label className="grid min-w-0 gap-0.5">
            Connection depth
            <select className={fieldClass} value={filters.depth} onChange={(event) => onChange({ ...filters, depth: Number(event.target.value) })}>
              {[1, 2, 3, 4, 5].map((depth) => <option key={depth}>{depth}</option>)}
            </select>
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

export function GraphNoteList({ graph, activeId, searching, onOpen }: {
  graph: NoteGraph;
  activeId: string;
  searching: boolean;
  onOpen: (id: string) => void;
}) {
  const [limit, setLimit] = useState(40);
  return (
    <details className="shrink-0">
      <summary className="cursor-pointer rounded-sm px-1 py-0.5 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <span aria-live="polite" aria-busy={searching}>{graph.nodes.length} {graph.nodes.length === 1 ? 'note' : 'notes'} · {graph.links.length} {graph.links.length === 1 ? 'connection' : 'connections'}</span>
      </summary>
      {graph.nodes.length > 0 && (
        <ul aria-label="Notes in graph" className="max-h-32 overflow-auto rounded-md border border-border bg-background p-0.5">
          {graph.nodes.slice(0, limit).map((note) => (
            <li key={note.id}>
              <button type="button" aria-current={note.id === activeId ? 'page' : undefined} title={note.path}
                onClick={() => onOpen(note.id)}
                className="block w-full truncate rounded-sm px-1.5 py-1 text-start text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-current:font-semibold">
                {note.name} <span className="text-muted-foreground">{note.path}</span>
              </button>
            </li>
          ))}
          {graph.nodes.length > limit && (
            <li><Button size="xs" variant="ghost" onClick={() => setLimit((current) => current + 40)}>Show more notes</Button></li>
          )}
        </ul>
      )}
    </details>
  );
}
