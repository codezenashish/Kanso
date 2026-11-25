import type { WikiIndex, WikiNote } from '@/lib/wiki-index';

export type GraphFilters = {
  query: string;
  folder: string;
  depth: number;
  showOrphans: boolean;
};

export type GraphMode = 'local' | 'global';
export type GraphEdge = { source: string; target: string; count: number };
export type NoteGraph = {
  nodes: WikiNote[];
  links: GraphEdge[];
  neighbors: Map<string, Set<string>>;
};

const normalize = (text: string) => text.normalize('NFC').toLocaleLowerCase();

function localNotes(index: WikiIndex, activeId: string, depth: number) {
  if (!index.catalog.notes.get(activeId)?.active) return [];
  const ids = [activeId];
  const visited = new Set(ids);
  let first = 0;
  for (let level = 0; level < depth && first < ids.length; level++) {
    const end = ids.length;
    for (; first < end; first++) {
      const id = ids[first];
      const visit = (neighbor: string | null) => {
        if (!neighbor || visited.has(neighbor) || !index.catalog.notes.get(neighbor)?.active) return;
        visited.add(neighbor);
        ids.push(neighbor);
      };
      for (const link of index.outgoing.get(id) ?? []) visit(link.targetId);
      for (const link of index.incoming.get(id) ?? []) visit(link.sourceId);
    }
  }
  return ids.map((id) => index.catalog.notes.get(id)!);
}

export function buildNoteGraph(index: WikiIndex, mode: GraphMode, activeId: string, depth: number): NoteGraph {
  const candidates = mode === 'local'
    ? localNotes(index, activeId, depth)
    : Array.from(index.catalog.notes.values()).filter((note) => note.active);
  const neighbors = new Map(candidates.map(({ id }) => [id, new Set<string>()]));
  const edges = new Map<string, GraphEdge>();
  for (const { id } of candidates) {
    for (const { targetId } of index.outgoing.get(id) ?? []) {
      if (!targetId || !neighbors.has(targetId)) continue;
      // Reciprocal references share one edge on the canvas.
      const [source, target] = id < targetId ? [id, targetId] : [targetId, id];
      neighbors.get(source)!.add(target);
      neighbors.get(target)!.add(source);
      const key = JSON.stringify([source, target]);
      const edge = edges.get(key);
      if (edge) edge.count++;
      else edges.set(key, { source, target, count: 1 });
    }
  }
  return { nodes: candidates, links: [...edges.values()], neighbors };
}

export function filterNoteGraph(graph: NoteGraph, filters: Omit<GraphFilters, 'depth'>, localRoot?: string): NoteGraph {
  const query = normalize(filters.query.trim());
  const nodes = graph.nodes.filter((note) => {
    const inFolder = !filters.folder || (filters.folder === '/' ? !note.path.includes('/') : note.path.startsWith(filters.folder + '/'));
    const matches = !query || normalize(note.path).includes(query) || normalize(note.name).includes(query);
    const connected = filters.showOrphans || note.id === localRoot || graph.neighbors.get(note.id)?.size;
    return inFolder && matches && connected;
  });
  const neighbors = new Map(nodes.map(({ id }) => [id, new Set<string>()]));
  const links = graph.links.filter(({ source, target }) => {
    if (!neighbors.has(source) || !neighbors.has(target)) return false;
    neighbors.get(source)!.add(target);
    neighbors.get(target)!.add(source);
    return true;
  });
  return { nodes, links, neighbors };
}
