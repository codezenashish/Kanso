import type { WorkspaceNode } from './database/workspace-types';
export type { NoteProperty, WorkspaceNode } from './database/workspace-types';

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

export function noteTags(node: WorkspaceNode): string[] {
  return node.properties
    ?.filter(({ name }) => name.toLowerCase() === 'tags')
    .flatMap(({ value }) => value.split(',').map((tag) => tag.trim()).filter(Boolean)) ?? [];
}

export function searchWorkspaceTree(nodes: WorkspaceNode[], query: string): WorkspaceNode[] {
  return nodes.flatMap((node) => {
    const children = node.children ? searchWorkspaceTree(node.children, query) : undefined;
    const matches = [node.name, node.content ?? '', ...noteTags(node)]
      .some((value) => value.toLowerCase().includes(query));
    return matches || children?.length ? [{ ...node, children }] : [];
  });
}
