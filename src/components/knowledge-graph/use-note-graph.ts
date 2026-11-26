import { useDeferredValue, useMemo } from 'react';
import type { WikiIndex } from '@/lib/wiki-index';
import { buildNoteGraph, filterNoteGraph, type GraphFilters, type GraphMode } from './graph-data';

export function useNoteGraph(
  index: WikiIndex,
  mode: GraphMode,
  activeId: string,
  filters: GraphFilters,
  noteTags?: ReadonlyMap<string, readonly string[]>,
) {
  const root = mode === 'local' ? activeId : '';
  const depth = mode === 'local' ? filters.depth : 0;
  const graph = useMemo(() => buildNoteGraph(index, mode, root, depth), [index, mode, root, depth]);
  const query = useDeferredValue(filters.query);
  const visible = useMemo(() => filterNoteGraph(graph, {
    query, folder: filters.folder, tag: filters.tag, showOrphans: filters.showOrphans,
  }, root, noteTags), [graph, query, filters.folder, filters.tag, filters.showOrphans, root, noteTags]);
  return { graph: visible, searching: query !== filters.query };
}
