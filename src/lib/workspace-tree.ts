import type { WorkspaceNode } from './database/workspace-types';
export type { NoteProperty, WorkspaceNode } from './database/workspace-types';

export const noteExtensionPattern = /\.(?:md|txt|ya?ml)$/i;
type NoteFormat = 'markdown' | 'text' | 'yaml';

export function getNoteFormat(name: string): NoteFormat {
  if (/\.txt$/i.test(name)) return 'text';
  if (/\.ya?ml$/i.test(name)) return 'yaml';
  return 'markdown';
}

export function isSourceOnlyNote(name: string): boolean {
  return getNoteFormat(name) !== 'markdown';
}

export function ensureNoteExtension(name: string): string {
  return noteExtensionPattern.test(name) ? name : `${name}.md`;
}

export function update(nodes: WorkspaceNode[], id: string, change: (node: WorkspaceNode) => WorkspaceNode): WorkspaceNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    let updated = node;
    if (node.id === id) updated = change(node);
    else if (node.children) {
      const children = update(node.children, id, change);
      if (children !== node.children) updated = { ...node, children };
    }
    changed ||= updated !== node;
    return updated;
  });
  return changed ? next : nodes;
}
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

export function availableTree(nodes: WorkspaceNode[], includeArchived = false): WorkspaceNode[] {
  return nodes.flatMap((node) => node.status === 'trashed' || (node.status === 'archived' && !includeArchived) ? [] : [{
    ...node,
    children: node.children ? availableTree(node.children, includeArchived) : undefined,
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

export { noteTags } from './note-tags';
