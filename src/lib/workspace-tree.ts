export type NoteProperty = { name: string; value: string };

export type WorkspaceNode = {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  content?: string;
  properties?: NoteProperty[];
  starred?: boolean;
  template?: boolean;
  status?: 'archived' | 'trashed';
  lastOpenedAt?: number;
  children?: WorkspaceNode[];
};
const initial: WorkspaceNode[] = [
  {
    id: 'welcome',
    name: 'Welcome.md',
    kind: 'file',
    content:
      '# Welcome to Kanso\n\nA quiet place for your thoughts.\n\nCreate a folder or a note from the explorer to get started.',
  },
  {
    id: 'journal',
    name: 'Journal',
    kind: 'folder',
    children: [
      {
        id: 'today',
        name: 'Today.md',
        kind: 'file',
        content: '# Today\n\nWhat would make today meaningful?',
      },
    ],
  },
  { id: 'ideas', name: 'Ideas', kind: 'folder', children: [] },
];
const workspaceStorageKey = 'kanso-tree';

type WorkspaceLoadResult =
  | { tree: WorkspaceNode[]; snapshot: string | null; invalid: boolean }
  | { tree: WorkspaceNode[]; unavailable: true };

function isNoteProperty(value: unknown): value is NoteProperty {
  return typeof value === 'object' && value !== null
    && 'name' in value && typeof value.name === 'string'
    && 'value' in value && typeof value.value === 'string';
}

function isWorkspaceNode(value: unknown, ids: Set<string>): value is WorkspaceNode {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  if (typeof node.id !== 'string' || !node.id || ids.has(node.id) || typeof node.name !== 'string'
    || (node.kind !== 'file' && node.kind !== 'folder')
    || (node.content !== undefined && typeof node.content !== 'string')
    || (node.properties !== undefined && (!Array.isArray(node.properties) || !node.properties.every(isNoteProperty)))
    || (node.status !== undefined && node.status !== 'archived' && node.status !== 'trashed')
    || (node.starred !== undefined && typeof node.starred !== 'boolean')
    || (node.template !== undefined && typeof node.template !== 'boolean')
    || (node.lastOpenedAt !== undefined && typeof node.lastOpenedAt !== 'number')) return false;
  ids.add(node.id);
  return node.children === undefined
    || (Array.isArray(node.children) && node.children.every((child) => isWorkspaceNode(child, ids)));
}

export function readWorkspace(): WorkspaceLoadResult {
  let snapshot: string | null;
  try {
    snapshot = localStorage.getItem(workspaceStorageKey);
  } catch {
    return { tree: initial, unavailable: true };
  }
  if (snapshot === null) return { tree: initial, snapshot, invalid: false };

  try {
    const tree: unknown = JSON.parse(snapshot);
    const ids = new Set<string>();
    if (Array.isArray(tree) && tree.every((node) => isWorkspaceNode(node, ids))) {
      return { tree, snapshot, invalid: false };
    }
  } catch {
    // Keep the original value available for recovery.
  }
  return { tree: initial, snapshot, invalid: true };
}

export function writeWorkspace(tree: WorkspaceNode[], expectedSnapshot: string | null, preserveOriginal: boolean) {
  if (localStorage.getItem(workspaceStorageKey) !== expectedSnapshot) return { status: 'conflict' } as const;
  const snapshot = JSON.stringify(tree);
  if (preserveOriginal && expectedSnapshot !== null) {
    const backupPrefix = `${workspaceStorageKey}-recovery`;
    let backupKey = backupPrefix;
    let copyNumber = 1;
    let existing = localStorage.getItem(backupKey);
    while (existing !== null && existing !== expectedSnapshot) {
      backupKey = `${backupPrefix}-${++copyNumber}`;
      existing = localStorage.getItem(backupKey);
    }
    if (existing === null) localStorage.setItem(backupKey, expectedSnapshot);
  }
  localStorage.setItem(workspaceStorageKey, snapshot);
  return { status: 'saved', snapshot } as const;
}
export const update = (nodes: WorkspaceNode[], id: string, fn: (n: WorkspaceNode) => WorkspaceNode): WorkspaceNode[] =>
  nodes.map((n) =>
    n.id === id ? fn(n) : { ...n, children: n.children ? update(n.children, id, fn) : undefined },
  );
export const remove = (nodes: WorkspaceNode[], id: string): WorkspaceNode[] =>
  nodes
    .filter((n) => n.id !== id)
    .map((n) => ({ ...n, children: n.children ? remove(n.children, id) : undefined }));
export const insert = (nodes: WorkspaceNode[], parent: string | null, node: WorkspaceNode): WorkspaceNode[] =>
  parent === null
    ? [...nodes, node]
    : nodes.map((n) =>
        n.id === parent
          ? { ...n, children: [...(n.children || []), node] }
          : { ...n, children: n.children ? insert(n.children, parent, node) : undefined },
      );
export const find = (nodes: WorkspaceNode[], id: string): WorkspaceNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = n.children && find(n.children, id);
    if (f) return f;
  }
  return undefined;
};

export function availableTree(nodes: WorkspaceNode[]): WorkspaceNode[] {
  return nodes.flatMap((node) => node.status ? [] : [{
    ...node,
    children: node.children ? availableTree(node.children) : undefined,
  }]);
}

export function listWorkspaceNotes(nodes: WorkspaceNode[]): WorkspaceNode[] {
  return nodes.flatMap((node) => node.kind === 'file' ? [node] : listWorkspaceNotes(node.children ?? []));
}

export function listWorkspaceStatus(nodes: WorkspaceNode[], status: NonNullable<WorkspaceNode['status']>): WorkspaceNode[] {
  return nodes.flatMap((node) => {
    if (node.status === status) return [node];
    return node.status ? [] : listWorkspaceStatus(node.children ?? [], status);
  });
}
