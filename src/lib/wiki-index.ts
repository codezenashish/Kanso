import type { WorkspaceNode } from './database/workspace-types';
import { scanWikiLinks, wikiSyntax, type WikiReference } from './wiki-markdown';

export const noteExtension = /\.(?:md|txt|ya?ml)$/i;
const key = (name: string) => name.normalize('NFC').toLowerCase();
export const wikiName = (name: string) => name.replace(noteExtension, '');

export type WikiNote = { id: string; name: string; path: string; active: boolean };
export type IndexedWikiLink = WikiReference & { sourceId: string; targetId: string | null };
type Catalog = {
  notes: Map<string, WikiNote>;
  names: Map<string, string | null>;
  paths: Map<string, string | null>;
  folders: Map<string, string | null>;
};
export type WikiIndex = {
  catalog: Catalog;
  outgoing: Map<string, IndexedWikiLink[]>;
  incoming: Map<string, IndexedWikiLink[]>;
};

function addName(entries: Map<string, string | null>, text: string, id: string) {
  const normalized = key(text);
  const existing = entries.get(normalized);
  entries.set(normalized, existing === undefined || existing === id ? id : null);
}

function catalogNotes(tree: WorkspaceNode[]) {
  const catalog: Catalog = { notes: new Map(), names: new Map(), paths: new Map(), folders: new Map() };
  const files: WorkspaceNode[] = [];
  function visit(nodes: WorkspaceNode[], parent = '', active = true) {
    for (const node of nodes) {
      const path = parent + node.name;
      const available = active && !node.status;
      if (node.kind === 'folder') {
        if (available) addName(catalog.folders, path, node.id);
        visit(node.children ?? [], path + '/', available);
      } else {
        files.push(node);
        catalog.notes.set(node.id, { id: node.id, name: wikiName(node.name), path, active: available });
        for (const name of [node.name, wikiName(node.name)]) addName(catalog.names, name, node.id);
        for (const name of [path, wikiName(path)]) addName(catalog.paths, name, node.id);
      }
    }
  }
  visit(tree);
  return { catalog, files };
}

export function resolveWikiLink(catalog: Catalog, target: string) {
  const path = target.trim();
  const bucket = path.includes('/') ? catalog.paths : catalog.names;
  const id = bucket.get(key(path.replace(/^\//, '')));
  if (id) return catalog.notes.get(id);
  const qualifier = /^(.*)#\^([A-Za-z0-9_-]+)$/.exec(path);
  if (!qualifier) return undefined;
  const note = catalog.notes.get(qualifier[2]);
  return note && key(qualifier[1].replace(/^\//, '')) === key(note.path) ? note : undefined;
}

export function wikiTarget(catalog: Catalog, note: WikiNote) {
  if (!/[\[\]|\\/\r\n]/.test(note.name) && resolveWikiLink(catalog, note.name)?.id === note.id) return note.name;
  for (const path of [wikiName(note.path), note.path]) {
    if (!/[\[\]|\\\r\n]/.test(path) && resolveWikiLink(catalog, '/' + path)?.id === note.id) {
      return path.includes('/') ? path : '/' + path;
    }
  }
  if (/[\[\]|\\\r\n]/.test(note.path) || !/^[A-Za-z0-9_-]+$/.test(note.id)) return null;
  const qualified = `${note.path}#^${note.id}`;
  return resolveWikiLink(catalog, qualified)?.id === note.id ? qualified : null;
}

export function wikiNoteLocation(catalog: Catalog, target: string) {
  if (/#\^[A-Za-z0-9_-]+$/.test(target)) return null;
  const path = target.replace(/^\//, '');
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  if (!name || name.trim() !== name || /[\[\]|\\\r\n]/.test(name) || name === '.' || name === '..') return null;
  const parent = slash < 0 ? null : catalog.folders.get(key(path.slice(0, slash)));
  if (slash >= 0 && !parent) return null;
  const qualified = target.includes('/');
  const bucket = qualified ? catalog.paths : catalog.names;
  if (bucket.has(key(path)) || bucket.has(key(wikiName(path)))) return null;
  return { name: noteExtension.test(name) ? name : name + '.md', parent: parent ?? null };
}

function resolveReferences(catalog: Catalog, id: string, references: WikiReference[]): IndexedWikiLink[] {
  return references.map((reference) => ({ ...reference, sourceId: id, targetId: resolveWikiLink(catalog, reference.target)?.id ?? null }));
}

function addIncoming(incoming: WikiIndex['incoming'], links: IndexedWikiLink[]) {
  for (const link of links) {
    if (!link.targetId) continue;
    const entries = incoming.get(link.targetId);
    if (entries) entries.push(link);
    else incoming.set(link.targetId, [link]);
  }
}

function sameLinks(left: IndexedWikiLink[], right: IndexedWikiLink[]) {
  return left === right || (left.length === right.length && left.every((link, index) => {
    const other = right[index];
    return link.start === other.start && link.end === other.end && link.sourceId === other.sourceId
      && link.targetId === other.targetId && link.target === other.target && link.alias === other.alias
      && link.context === other.context;
  }));
}

export function buildWikiIndex(tree: WorkspaceNode[], stored?: IndexedWikiLink[]): WikiIndex {
  const { catalog, files } = catalogNotes(tree);
  const outgoing: WikiIndex['outgoing'] = new Map();
  if (stored) {
    for (const link of stored) {
      const entries = outgoing.get(link.sourceId);
      if (entries) entries.push(link);
      else outgoing.set(link.sourceId, [link]);
    }
  } else {
    for (const note of files) {
      if (/\.(?:txt|ya?ml)$/i.test(note.name)) continue;
      const links = resolveReferences(catalog, note.id, scanWikiLinks(note.content ?? ''));
      if (links.length) outgoing.set(note.id, links);
    }
  }
  const incoming: WikiIndex['incoming'] = new Map();
  for (const links of outgoing.values()) addIncoming(incoming, links);
  return { catalog, outgoing, incoming };
}

export function editWikiIndex(index: WikiIndex, id: string, content: string): WikiIndex {
  const note = index.catalog.notes.get(id);
  if (!note || /\.(?:txt|ya?ml)$/i.test(note.path)) return index;
  const previous = index.outgoing.get(id) ?? [];
  if (!previous.length && !content.includes('[[')) return index;
  const links = resolveReferences(index.catalog, id, scanWikiLinks(content));
  if (sameLinks(previous, links)) return index;
  const outgoing = new Map(index.outgoing);
  if (links.length) outgoing.set(id, links);
  else outgoing.delete(id);
  const incoming = new Map(index.incoming);
  const previousTargets = new Set(previous.flatMap((link) => link.targetId ? [link.targetId] : []));
  const nextTargets = new Set(links.flatMap((link) => link.targetId ? [link.targetId] : []));
  for (const target of new Set([...previousTargets, ...nextTargets])) {
    const remaining = (incoming.get(target) ?? []).filter((link) => link.sourceId !== id);
    if (remaining.length) incoming.set(target, remaining);
    else incoming.delete(target);
  }
  addIncoming(incoming, links);
  return { catalog: index.catalog, outgoing, incoming };
}

export function refreshWikiStructure(tree: WorkspaceNode[], previous: WikiIndex) {
  const { catalog, files } = catalogNotes(tree);
  const contents = new Map<string, string>();
  const outgoing: WikiIndex['outgoing'] = new Map();
  const incoming: WikiIndex['incoming'] = new Map();
  for (const note of files) {
    if (/\.(?:txt|ya?ml)$/i.test(note.name)) continue;
    const links = previous.outgoing.get(note.id) ?? [];
    let content = note.content ?? '';
    for (const link of [...links].reverse()) {
      if (!link.targetId) continue;
      const target = catalog.notes.get(link.targetId);
      if (!target) continue;
      const oldTarget = previous.catalog.notes.get(target.id);
      if (oldTarget?.path === target.path && resolveWikiLink(catalog, link.target)?.id === target.id) continue;
      const next = wikiTarget(catalog, target);
      if (next && next !== link.target) {
        const original = content.slice(link.start, link.end);
        content = content.slice(0, link.start) + wikiSyntax(next, link.alias, original.includes('\\|')) + content.slice(link.end);
      }
    }
    if (content !== (note.content ?? '')) contents.set(note.id, content);
    const oldNote = previous.catalog.notes.get(note.id);
    const references = !oldNote || /\.(?:txt|ya?ml)$/i.test(oldNote.path) || contents.has(note.id) ? scanWikiLinks(content) : links;
    const resolved = resolveReferences(catalog, note.id, references);
    if (resolved.length) outgoing.set(note.id, resolved);
    addIncoming(incoming, resolved);
  }
  function applyContents(nodes: WorkspaceNode[]): WorkspaceNode[] {
    return nodes.map((node) => {
      const content = contents.get(node.id);
      if (content !== undefined) return { ...node, content };
      return node.children ? { ...node, children: applyContents(node.children) } : node;
    });
  }
  return { tree: contents.size ? applyContents(tree) : tree, wiki: { catalog, outgoing, incoming } };
}

export function wikiLinkChanges(wiki: WikiIndex, previous?: WikiIndex) {
  if (wiki === previous) return [];
  const ids = new Set([...wiki.outgoing.keys(), ...previous?.outgoing.keys() ?? []]);
  return Array.from(ids).flatMap((id) => {
    const links = wiki.outgoing.get(id) ?? [];
    const old = previous?.outgoing.get(id);
    return old && sameLinks(links, old) ? [] : [{ id, links }];
  });
}
