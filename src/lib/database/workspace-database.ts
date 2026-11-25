import { invoke } from '@tauri-apps/api/core';
import { availableTree, find, noteTags } from '@/lib/workspace-tree';
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
  properties?: WorkspaceNode['properties'] | null;
  starred?: number;
  template?: number;
  lastOpenedAt?: number | null;
};

type StoredWorkspace = {
  revision: number;
  legacyDigest: string | null;
  nodes: StoredNode[];
  tabs: { id: string; active: number }[];
  expanded: string[];
  wikiLinks: IndexedWikiLink[] | null;
};

function flattenTree(tree: WorkspaceNode[], parent: string | null = null): object[] {
  return tree.flatMap(({ children, ...node }, position): object[] => {
    const entry = { ...node, parent, position };
    if (node.kind === 'folder') return [entry, ...flattenTree(children ?? [], node.id)];
    const format = /\.txt$/i.test(node.name) ? 'text' : /\.ya?ml$/i.test(node.name) ? 'yaml' : 'markdown';
    return [{ ...entry, format, tags: noteTags(node) }];
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

export function saveSnapshot(snapshot: WorkspaceSnapshot, revision: number | null, legacyDigest: string | null = null, previousWiki?: WikiIndex) {
  const visible = availableTree(snapshot.tree);
  const tabs = snapshot.openFiles.filter((id) => find(visible, id)?.kind === 'file');
  return invoke<number | null>('save_workspace', {
    revision,
    legacyDigest,
    snapshot: {
      wikiChanges: wikiLinkChanges(snapshot.wiki, previousWiki),
      nodes: flattenTree(snapshot.tree),
      expanded: snapshot.expanded,
      tabs: tabs.map((id) => ({ id, active: Number(id === snapshot.active) })),
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
  const visible = availableTree(tree);
  const tabs = stored.tabs.filter(({ id }) => find(visible, id)?.kind === 'file');
  const snapshot: WorkspaceSnapshot = {
    tree,
    wiki: buildWikiIndex(tree, stored.wikiLinks ?? undefined),
    openFiles: tabs.map(({ id }) => id),
    active: tabs.find(({ active }) => active)?.id ?? tabs[tabs.length - 1]?.id ?? '',
    expanded: stored.expanded,
  };
  let revision = stored.revision;
  if (stored.wikiLinks == null) {
    const indexedRevision = await saveSnapshot(snapshot, revision);
    if (indexedRevision === null) {
      const current = await invoke<StoredWorkspace | null>('load_workspace');
      if (!current?.wikiLinks) throw new Error('Wiki link indexing could not be confirmed.');
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
