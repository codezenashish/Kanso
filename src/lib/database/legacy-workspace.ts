import type { NoteProperty, WorkspaceNode } from './workspace-types';

export const initialTree: WorkspaceNode[] = [
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
export const workspaceStorageKey = 'kanso-tree';

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
  // The legacy UI only attached editor data to files and children to folders.
  // Keep any other shape available for recovery rather than importing a partial copy.
  if (node.kind === 'folder' && (node.content || node.properties || node.starred
    || node.template || node.lastOpenedAt !== undefined)) return false;
  if (node.kind === 'file' && Array.isArray(node.children) && node.children.length > 0) return false;
  ids.add(node.id);
  return node.children === undefined
    || (Array.isArray(node.children) && node.children.every((child) => isWorkspaceNode(child, ids)));
}

export function parseLegacyWorkspace(snapshot: string): WorkspaceNode[] | null {
  try {
    const tree: unknown = JSON.parse(snapshot);
    const ids = new Set<string>();
    return Array.isArray(tree) && tree.every((node) => isWorkspaceNode(node, ids)) ? tree : null;
  } catch {
    return null;
  }
}
