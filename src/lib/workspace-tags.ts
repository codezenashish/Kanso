import { noteTags, replaceNoteTags, tagKey, uniqueTags, validTagName } from './note-tags';
import type { WorkspaceNode } from './database/workspace-types';

export type TagMutation = { kind: 'create' | 'rename' | 'merge' | 'remove'; source?: string; name?: string };

export type WorkspaceTag = {
  key: string;
  name: string;
  active: number;
  archived: number;
  trashed: number;
};

export function buildWorkspaceTags(tree: WorkspaceNode[], managed: string[]) {
  const index = new Map<string, WorkspaceTag>();
  function entry(name: string) {
    const key = tagKey(name);
    const previous = index.get(key);
    if (previous) return previous;
    const created = { key, name, active: 0, archived: 0, trashed: 0 };
    index.set(key, created);
    return created;
  }
  for (const name of managed) entry(name);
  function visit(nodes: WorkspaceNode[], parent: 'active' | 'archived' | 'trashed') {
    for (const node of nodes) {
      const status = parent === 'trashed' || node.status === 'trashed' ? 'trashed' : node.status ?? parent;
      if (node.kind === 'folder') visit(node.children ?? [], status);
      else for (const name of noteTags(node)) entry(name)[status]++;
    }
  }
  visit(tree, 'active');
  return index;
}

type TagMutationPlan = { error: string } | { tree: WorkspaceNode[]; managed: string[]; count: number };

export function planTagMutation(tree: WorkspaceNode[], managed: string[], mutation: TagMutation): TagMutationPlan {
  const index = buildWorkspaceTags(tree, managed);
  const source = mutation.source ? index.get(mutation.source) : undefined;
  const name = mutation.name?.trim() ?? '';
  const target = index.get(tagKey(name));
  if (mutation.kind !== 'remove' && !validTagName(name)) {
    return { error: 'Enter a tag name without commas or control characters.' };
  }
  if (mutation.kind === 'create') {
    return target ? { error: 'That tag already exists.' }
      : { tree, managed: [...managed, name], count: 0 };
  }
  if (!source) return { error: 'That tag is no longer available.' };
  if (mutation.kind === 'rename' && target && target.key !== source.key) {
    return { error: 'That tag already exists. Choose Merge to combine them.' };
  }
  if (mutation.kind === 'merge' && (!target || target.key === source.key)) {
    return { error: 'Choose a different existing tag to merge into.' };
  }

  const sourceKey = source.key;
  const label = mutation.kind === 'merge' ? target?.name : mutation.kind === 'remove' ? undefined : name;
  let count = 0;
  const blocked: string[] = [];
  function visit(nodes: WorkspaceNode[]): WorkspaceNode[] {
    let changed = false;
    const next = nodes.map((node) => {
      if (node.kind === 'folder') {
        const children = visit(node.children ?? []);
        if (children === node.children || (!node.children && !children.length)) return node;
        changed = true;
        return { ...node, children };
      }
      const tags = noteTags(node);
      if (!tags.some((value) => tagKey(value) === sourceKey)) return node;
      const replacement = tags.flatMap((value) => tagKey(value) === sourceKey ? label ? [label] : [] : [value]);
      const updated = replaceNoteTags(node, replacement);
      if (!updated) {
        blocked.push(node.name);
        return node;
      }
      changed = true;
      count++;
      return updated;
    });
    return changed ? next : nodes;
  }
  const result = visit(tree);
  if (blocked.length) return { error: `Edit the YAML tags in Source Mode before changing this tag: ${blocked.join(', ')}.` };
  return {
    tree: result,
    managed: uniqueTags([...managed.filter((tag) => tagKey(tag) !== sourceKey), ...(label ? [label] : [])]),
    count,
  };
}
