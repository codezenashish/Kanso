import { useMemo, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Maximize2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { WikiIndex } from '@/lib/wiki-index';
import { GraphCanvas } from './graph-canvas';
import { GraphControls, GraphNoteList } from './graph-controls';
import type { GraphFilters, GraphMode } from './graph-data';
import { useNoteGraph } from './use-note-graph';

type GraphPanelProps = {
  index: WikiIndex;
  activeId: string;
  onOpenNote: (id: string) => void;
};

const defaultFilters: GraphFilters = { query: '', folder: '', depth: 1, showOrphans: false };

function GraphView({ index, activeId, onOpenNote, mode, compact, filters, setFilters }: GraphPanelProps & {
  mode: GraphMode;
  compact: boolean;
  filters: GraphFilters;
  setFilters: (filters: GraphFilters) => void;
}) {
  const folders = useMemo(() => {
    const paths = new Set<string>();
    for (const note of index.catalog.notes.values()) {
      if (!note.active) continue;
      let separator = note.path.indexOf('/');
      while (separator !== -1) {
        paths.add(note.path.slice(0, separator));
        separator = note.path.indexOf('/', separator + 1);
      }
    }
    return [...paths].sort((left, right) => left.localeCompare(right));
  }, [index.catalog]);
  const currentFilters = filters.folder && filters.folder !== '/' && !folders.includes(filters.folder)
    ? { ...filters, folder: '' }
    : filters;
  const { graph, searching } = useNoteGraph(index, mode, activeId, currentFilters);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
      <GraphControls filters={currentFilters} onChange={setFilters} folders={folders} mode={mode} />
      <GraphCanvas graph={graph} activeId={activeId} compact={compact} onOpenNote={onOpenNote} />
      <GraphNoteList graph={graph} activeId={activeId} searching={searching} onOpen={onOpenNote} />
    </div>
  );
}

export default function GraphPanel(props: GraphPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<GraphMode>('global');
  const [localFilters, setLocalFilters] = useState(defaultFilters);
  const [globalFilters, setGlobalFilters] = useState(defaultFilters);

  return (
    <Dialog.Root open={expanded} onOpenChange={setExpanded}>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium">Local graph</h2>
          <Dialog.Trigger render={<Button variant="ghost" size="icon-xs" />} aria-label="Open workspace graph" title="Open workspace graph">
            <Maximize2 aria-hidden="true" />
          </Dialog.Trigger>
        </div>
        {!expanded && <GraphView {...props} mode="local" compact filters={localFilters} setFilters={setLocalFilters} />}
      </div>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-foreground/25" />
        <Dialog.Popup className="fixed inset-x-3 top-1/2 z-50 mx-auto flex h-[min(48rem,calc(100dvh-1.5rem))] max-w-6xl -translate-y-1/2 flex-col gap-2 rounded-xl border border-border overflow-x-hidden overflow-y-auto bg-card p-3 text-card-foreground shadow-xl outline-none sm:p-4">
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Dialog.Title className="me-auto text-base font-medium">Knowledge graph</Dialog.Title>
            <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5" role="group" aria-label="Graph mode">
              {(['global', 'local'] as const).map((option) => (
                <Button key={option} variant={mode === option ? 'secondary' : 'ghost'} size="xs"
                  aria-pressed={mode === option} onClick={() => setMode(option)}>
                  {option === 'global' ? 'Global' : 'Local'}
                </Button>
              ))}
            </div>
            <Dialog.Close render={<Button variant="ghost" size="icon-sm" />} aria-label="Close workspace graph">
              <X aria-hidden="true" />
            </Dialog.Close>
          </div>
          {expanded && <GraphView {...props} mode={mode} compact={false}
            filters={mode === 'local' ? localFilters : globalFilters}
            setFilters={mode === 'local' ? setLocalFilters : setGlobalFilters}
            onOpenNote={(id) => {
              props.onOpenNote(id);
              setExpanded(false);
            }} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
