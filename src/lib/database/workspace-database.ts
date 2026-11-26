import { buildWorkspaceTags } from '@/lib/workspace-tags';
import { tagKey } from '@/lib/note-tags';
import { invoke } from '@tauri-apps/api/core';
import { availableTree, find, getNoteFormat, listWorkspaceNotes, noteTags } from '@/lib/workspace-tree';
import { buildWikiIndex, wikiLinkChanges, type IndexedWikiLink, type WikiIndex } from '@/lib/wiki-index';
import { initialTree, parseLegacyWorkspace, workspaceStorageKey } from './legacy-workspace';
import type { WorkspaceNode, WorkspaceSnapshot } from './workspace-types';

type StoredNode = {
  id: string;
  name: string;
  kind: WorkspaceNode['kind'];
  parent: string | null;
  status: WorkspaceNode['status'] | null;
  content?: string | null;
  tags?: string[];
  properties?: WorkspaceNode['properties'] | null;
  starred?: number;
  template?: number;
  lastOpenedAt?: number | null;
};

type StoredWorkspace = {
  revision: number;
  legacyDigest: string | null;
  nodes: StoredNode[];
  tabs: { id: string; active: number; pinned?: number }[];
  expanded: string[];
  managedTags?: string[];
  wikiLinks: IndexedWikiLink[] | null;
};

function flattenTree(tree: WorkspaceNode[], catalog: ReturnType<typeof buildWorkspaceTags>, parent: string | null = null): object[] {
  return tree.flatMap((current, position): object[] => {
    const { children, ...node } = current;
    const entry = { ...node, parent, position };
    if (node.kind === 'folder') return [entry, ...flattenTree(children ?? [], catalog, node.id)];
    return [{ ...entry, format: getNoteFormat(node.name), tags: noteTags(current).map((name) => catalog.get(tagKey(name))?.name ?? name) }];
  });
}

function restoreTree(rows: StoredNode[]): WorkspaceNode[] {
  const tree: WorkspaceNode[] = [];
  const folders = new Map<string, WorkspaceNode[]>();
  for (const row of rows) {
    if (row.kind === 'folder') folders.set(row.id, []);
  }
  for (const row of rows) {
    const siblings = row.parent === null ? tree : folders.get(row.parent);
    if (!siblings) throw new Error('Workspace folder could not be found.');
    const node = { id: row.id, name: row.name, kind: row.kind, status: row.status ?? undefined };
    siblings.push(row.kind === 'folder' ? { ...node, children: folders.get(row.id) } : {
      ...node,
      content: row.content ?? undefined,
      properties: row.properties ?? undefined,
      starred: Boolean(row.starred),
      template: Boolean(row.template),
      lastOpenedAt: row.lastOpenedAt ?? undefined,
    });
  }
  return tree;
}

export function saveSnapshot(snapshot: WorkspaceSnapshot, revision: number | null, legacyDigest: string | null = null, previousWiki?: WikiIndex, recordHistory = true) {
  const visible = availableTree(snapshot.tree, true);
  const tabs = snapshot.openFiles.filter((id) => find(visible, id)?.kind === 'file');
  const pinned = new Set(snapshot.pinnedFiles);
  return invoke<number | null>('save_workspace', {
    revision,
    legacyDigest,
    history: recordHistory ? undefined : { enabled: false, snapshotIntervalMs: 0, maxVersionsPerNote: 1, maxAgeDays: null },
    snapshot: {
      wikiChanges: wikiLinkChanges(snapshot.wiki, previousWiki),
      nodes: flattenTree(snapshot.tree, buildWorkspaceTags(snapshot.tree, snapshot.managedTags)),
      managedTags: snapshot.managedTags,
      expanded: snapshot.expanded,
      tabs: tabs.map((id) => ({ id, active: Number(id === snapshot.active), pinned: Number(pinned.has(id)) })),
    },
  });
}

async function legacyDigest(snapshot: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readLegacyBackup(imported: string | null): Promise<string | null> {
  let pending: string | null = null;
  try {
    pending = localStorage.getItem(workspaceStorageKey);
    if (pending === null || imported === null || await legacyDigest(pending) !== imported) return pending;
    const current = localStorage.getItem(workspaceStorageKey);
    if (current !== pending) return current;
    localStorage.removeItem(workspaceStorageKey);
  } catch {
    return pending;
  }
  return null;
}

async function restoreWorkspace(stored: StoredWorkspace) {
  const tree = restoreTree(stored.nodes);
  const visible = availableTree(tree, true);
  const tabs = stored.tabs.filter(({ id }) => find(visible, id)?.kind === 'file');
  const snapshot: WorkspaceSnapshot = {
    tree,
    wiki: buildWikiIndex(tree, stored.wikiLinks ?? undefined),
    openFiles: tabs.map(({ id }) => id),
    pinnedFiles: tabs.filter(({ pinned }) => pinned === 1).map(({ id }) => id),
    active: tabs.find(({ active }) => active)?.id ?? tabs[tabs.length - 1]?.id ?? '',
    expanded: stored.expanded,
    managedTags: stored.managedTags ?? [],
  };
  let revision = stored.revision;
  const indexedTags = new Map(stored.nodes.filter((node) => node.tags).map(({ id, tags }) => [id, tags ?? []]));
  const tagsNeedRefresh = listWorkspaceNotes(tree).some((note) => {
    const stored = indexedTags.get(note.id);
    return stored !== undefined && JSON.stringify(stored.map(tagKey).sort()) !== JSON.stringify(noteTags(note).map(tagKey).sort());
  });
  if (stored.wikiLinks == null || tagsNeedRefresh) {
    const indexedRevision = await saveSnapshot(snapshot, revision, null, undefined, false);
    if (indexedRevision === null) {
      const current = await invoke<StoredWorkspace | null>('load_workspace');
      if (!current?.wikiLinks) throw new Error('Workspace indexing could not be confirmed.');
      return restoreWorkspace(current);
    }
    revision = indexedRevision;
  }
  return { snapshot, revision, recoverySnapshot: await readLegacyBackup(stored.legacyDigest) };
}

async function loadWorkspace() {
  const stored = await invoke<StoredWorkspace | null>('load_workspace');
  if (stored) return restoreWorkspace(stored);

  const legacy = localStorage.getItem(workspaceStorageKey);
  const imported = legacy === null ? null : parseLegacyWorkspace(legacy);
  const tree = imported ?? initialTree;
  const visible = availableTree(tree);
  const active = find(visible, 'welcome')?.kind === 'file' ? 'welcome' : '';
  const snapshot: WorkspaceSnapshot = {
    tree,
    wiki: buildWikiIndex(tree),
    active,
    openFiles: active ? [active] : [],
    pinnedFiles: [],
    managedTags: [],
    expanded: find(visible, 'journal')?.kind === 'folder' ? ['journal'] : [],
  };
  const migratedLegacy = imported && legacy !== null ? await legacyDigest(legacy) : null;
  await saveSnapshot(snapshot, null, migratedLegacy);
  const current = await invoke<StoredWorkspace | null>('load_workspace');
  if (!current) throw new Error('Workspace initialization could not be confirmed.');
  return restoreWorkspace(current);
}

let pendingLoad: ReturnType<typeof loadWorkspace> | undefined;

export function openWorkspaceDatabase() {
  pendingLoad ??= loadWorkspace().finally(() => { pendingLoad = undefined; });
  return pendingLoad;
}
