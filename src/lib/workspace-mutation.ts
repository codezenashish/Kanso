import { find, insert, remove, update, type WorkspaceNode } from './workspace-tree';

export function locateWorkspaceNode(nodes: WorkspaceNode[], id: string, parent: string | null = null, parentStatus?: WorkspaceNode['status']): {
  node: WorkspaceNode;
  parent: string | null;
  index: number;
  status: WorkspaceNode['status'];
} | undefined {
  for (const [index, node] of nodes.entries()) {
    const status = parentStatus === 'trashed' || node.status === 'trashed' ? 'trashed' : parentStatus ?? node.status;
    if (node.id === id) return { node, parent, index, status };
    if (node.children) {
      const match = locateWorkspaceNode(node.children, id, node.id, status);
      if (match) return match;
    }
  }
}

export function destinationSiblings(tree: WorkspaceNode[], parent: string | null, allowArchived = false) {
  if (parent === null) return tree;
  const folder = locateWorkspaceNode(tree, parent);
  if (folder?.node.kind !== 'folder' || folder.status === 'trashed' || (folder.status && !allowArchived)) return null;
  return folder.node.children ?? [];
}

export function nameConflict(siblings: WorkspaceNode[], name: string, except?: string) {
  const key = name.normalize('NFC').toLowerCase();
  return siblings.some((node) => node.id !== except && node.status !== 'trashed'
    && node.name.normalize('NFC').toLowerCase() === key);
}

export function moveWorkspaceNode(tree: WorkspaceNode[], id: string, parent: string | null, index?: number) {
  const node = find(tree, id);
  const siblings = destinationSiblings(tree, parent);
  if (!node || !siblings || nameConflict(siblings, node.name, id) || id === parent
    || (parent !== null && find(node.children ?? [], parent))) return tree;
  const moved = node;
  const without = remove(tree, id);
  if (index === undefined) return insert(without, parent, node);
  const position = index;
  function insertAt(siblings: WorkspaceNode[]) {
    const result = [...siblings];
    result.splice(position, 0, moved);
    return result;
  }
  return parent === null ? insertAt(without) : update(without, parent, (folder) => ({
    ...folder, children: insertAt(folder.children ?? []),
  }));
}
