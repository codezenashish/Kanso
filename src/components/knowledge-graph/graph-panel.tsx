import { tagKey } from '@/lib/note-tags';
import { useMemo, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Maximize2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { WikiIndex } from '@/lib/wiki-index';
import { GraphCanvas } from './graph-canvas';
import { GraphControls, GraphNoteList, type GraphTagOption } from './graph-controls';
import { type GraphFilters, type GraphMode } from './graph-data';
import { useNoteGraph } from './use-note-graph';

type GraphPanelProps = {
  index: WikiIndex;
  activeId: string;
  noteTags: ReadonlyMap<string, readonly string[]>;
  onOpenNote: (id: string) => void;
};

const defaultFilters: GraphFilters = { query: '', folder: '', tag: '', depth: 1, showOrphans: false };

function GraphView({ index, activeId, noteTags, onOpenNote, mode, compact, filters, setFilters, focusId, onResetFocus, onFocusLocal }: GraphPanelProps & {
  mode: GraphMode;
  compact: boolean;
  filters: GraphFilters;
  setFilters: (filters: GraphFilters) => void;
  focusId?: string;
  onResetFocus?: () => void;
  onFocusLocal: (id: string) => void;
}) {
  const { folders, tags } = useMemo(() => {
    const folderPaths = new Set<string>();
    const tagMap = new Map<string, string>();
    for (const note of index.catalog.notes.values()) {
      if (!note.active) continue;
      let separator = note.path.indexOf('/');
      while (separator !== -1) {
        folderPaths.add(note.path.slice(0, separator));
        separator = note.path.indexOf('/', separator + 1);
      }
      for (const rawTag of noteTags.get(note.id) ?? []) {
        const key = tagKey(rawTag);
        if (key && !tagMap.has(key)) tagMap.set(key, rawTag);
      }
    }
    return {
      folders: [...folderPaths].sort((left, right) => left.localeCompare(right)),
      tags: [...tagMap.entries()]
        .map(([value, label]): GraphTagOption => ({ value, label }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    };
  }, [index.catalog, noteTags]);

  const currentFolder = filters.folder && filters.folder !== '/' && !folders.includes(filters.folder) ? '' : filters.folder;
  const currentTag = filters.tag && !tags.some((entry) => entry.value === filters.tag) ? '' : filters.tag;
  const currentFilters = currentFolder === filters.folder && currentTag === filters.tag
    ? filters
    : { ...filters, folder: currentFolder, tag: currentTag };

  const localRoot = mode === 'local' ? (focusId ?? activeId) : activeId;
  const focusedNote = mode === 'local' && localRoot && localRoot !== activeId
    ? index.catalog.notes.get(localRoot)
    : undefined;
  const { graph, searching } = useNoteGraph(index, mode, localRoot, currentFilters, noteTags);
  const canvasFocusId = mode === 'local' ? focusId : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
      <GraphControls filters={currentFilters} onChange={setFilters} folders={folders} tags={tags} mode={mode} />
      {focusedNote && (
        <div className="flex min-w-0 shrink-0 items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            Focused: <span className="font-medium text-foreground">{focusedNote.name}</span>
          </span>
          <Button type="button" variant="ghost" size="xs" onClick={() => onOpenNote(focusedNote.id)}>
            Open
          </Button>
          {onResetFocus && (
            <Button type="button" variant="ghost" size="xs" onClick={onResetFocus}>
              Reset
            </Button>
          )}
        </div>
      )}
      <GraphCanvas
        graph={graph}
        activeId={activeId}
        focusId={canvasFocusId}
        compact={compact}
        onOpenNote={onOpenNote}
        onFocusLocal={onFocusLocal}
      />
      <GraphNoteList
        graph={graph}
        activeId={activeId}
        focusId={canvasFocusId}
        searching={searching}
        onOpen={onOpenNote}
        onFocusLocal={onFocusLocal}
      />
    </div>
  );
}

export default function GraphPanel({ expanded, setExpanded, ...props }: GraphPanelProps & {
  expanded: boolean;
  setExpanded: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<GraphMode>('global');
  const [localFilters, setLocalFilters] = useState(defaultFilters);
  const [globalFilters, setGlobalFilters] = useState(defaultFilters);
  const [localFocus, setLocalFocus] = useState<{ forActiveId: string; targetId: string } | null>(null);

  const effectiveLocalRoot = localFocus
    && localFocus.forActiveId === props.activeId
    && props.index.catalog.notes.get(localFocus.targetId)?.active
    ? localFocus.targetId
    : props.activeId;

  function focusNote(id: string, openLocalMode: boolean) {
    setLocalFocus(id === props.activeId ? null : { forActiveId: props.activeId, targetId: id });
    if (openLocalMode) setMode('local');
  }

  return (
    <Dialog.Root open={expanded} onOpenChange={setExpanded}>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium">Local graph</h2>
          <Dialog.Trigger render={<Button variant="ghost" size="icon-xs" />} aria-label="Open workspace graph" title="Open workspace graph">
            <Maximize2 aria-hidden="true" />
          </Dialog.Trigger>
        </div>
        {!expanded && (
          <GraphView
            {...props}
            mode="local"
            compact
            filters={localFilters}
            setFilters={setLocalFilters}
            focusId={effectiveLocalRoot}
            onResetFocus={() => setLocalFocus(null)}
            onFocusLocal={(id) => focusNote(id, false)}
          />
        )}
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
          {expanded && (
            <GraphView
              {...props}
              mode={mode}
              compact={false}
              filters={mode === 'local' ? localFilters : globalFilters}
              setFilters={mode === 'local' ? setLocalFilters : setGlobalFilters}
              focusId={effectiveLocalRoot}
              onResetFocus={() => setLocalFocus(null)}
              onFocusLocal={(id) => focusNote(id, true)}
              onOpenNote={(id) => {
                setLocalFocus(null);
                props.onOpenNote(id);
                setExpanded(false);
              }}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
