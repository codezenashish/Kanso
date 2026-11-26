import { tagKey } from './note-tags';
import { noteTags, type WorkspaceNode } from './workspace-tree';

export type SearchFilters = { tag: string; folder: string; archive: 'active' | 'archived' | 'all' };
export const defaultSearchFilters: SearchFilters = { tag: '', folder: '', archive: 'active' };

type SearchNote = {
  note: WorkspaceNode;
  archived: boolean;
  path: string;
  folders: string[];
  tags: string[];
};

type SearchFolder = { name: string; path: string; folders: string[]; archived: boolean };

export type SearchRange = { start: number; end: number };
export type SearchResult = {
  entry: SearchNote;
  range?: SearchRange;
  titleMatch?: SearchRange;
  matchingTag?: string;
};

export function buildWorkspaceSearch(nodes: WorkspaceNode[], managedTags: string[] = []) {
  const notes = new Map<string, SearchNote>();
  const folders = new Map<string, SearchFolder>();
  const tags = new Map(managedTags.map((name) => [tagKey(name), name]));

  function visit(children: WorkspaceNode[], ancestors: string[], path: string, parentArchived: boolean) {
    for (const node of children) {
      if (node.status === 'trashed') continue;
      const archived = parentArchived || node.status === 'archived';
      if (node.kind === 'folder') {
        const folderPath = path ? path + ' / ' + node.name : node.name;
        folders.set(node.id, { name: node.name, path: folderPath, folders: ancestors, archived });
        visit(node.children ?? [], [...ancestors, node.id], folderPath, archived);
      } else {
        const noteTagList = noteTags(node);
        for (const tag of noteTagList) if (!tags.has(tagKey(tag))) tags.set(tagKey(tag), tag);
        notes.set(node.id, { note: node, archived, path, folders: ancestors, tags: noteTagList });
      }
    }
  }

  visit(nodes, [], '', false);
  return { notes, folders, tags };
}

export function isCurrentSearchResult(index: ReturnType<typeof buildWorkspaceSearch>, { entry }: SearchResult) {
  const current = index.notes.get(entry.note.id);
  return current !== undefined
    && current.note.name === entry.note.name
    && current.note.content === entry.note.content
    && current.archived === entry.archived
    && current.path === entry.path
    && current.folders.length === entry.folders.length
    && current.folders.every((folder, position) => folder === entry.folders[position])
    && current.tags.length === entry.tags.length
    && current.tags.every((tag, position) => tag === entry.tags[position]);
}

export function* searchWorkspace(index: ReturnType<typeof buildWorkspaceSearch>, query: string, filters: SearchFilters): Generator<SearchResult> {
  const literal = query.trim().replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const pattern = literal ? new RegExp(literal, 'giu') : null;
  for (const entry of index.notes.values()) {
    if ((filters.archive === 'active' && entry.archived) || (filters.archive === 'archived' && !entry.archived)) continue;
    if (filters.folder && !entry.folders.includes(filters.folder)) continue;
    if (filters.tag && !entry.tags.some((tag) => tagKey(tag) === filters.tag)) continue;
    if (!pattern) {
      yield { entry };
      continue;
    }

    const title = entry.note.name.matchAll(pattern).next().value;
    const titleMatch = title && { start: title.index, end: title.index + title[0].length };
    const matchingTag = entry.tags.find((tag) => tag.search(pattern) !== -1);
    let foundContent = false;
    for (const match of (entry.note.content ?? '').matchAll(pattern)) {
      foundContent = true;
      yield { entry, titleMatch, range: { start: match.index, end: match.index + match[0].length } };
    }
    if (!foundContent && (titleMatch || matchingTag)) yield { entry, titleMatch, matchingTag };
  }
}
