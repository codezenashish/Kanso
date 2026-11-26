import { availableTree, noteExtensionPattern, type WorkspaceNode } from './workspace-tree';

export type DestinationFolder = {
  id: string;
  name: string;
  path: string;
};

export type TemplateNotePlan =
  | {
      valid: true;
      requestedName: string;
      resolvedName: string;
      collided: boolean;
      destinationPath: string;
    }
  | {
      valid: false;
      error: string;
      requestedName: string;
      resolvedName: string;
      collided: false;
      destinationPath: string;
    };

const maxNoteNameLength = 180;
const forbiddenNameChars = /[\u0000-\u001f\u007f/\\[\]|]/;
const attachmentReferencePattern = /attachment(?::|&colon;)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

function nameKey(name: string) {
  return name.normalize('NFC').toLowerCase();
}

export function templateExtension(templateName: string) {
  return templateName.match(noteExtensionPattern)?.[0] ?? '.md';
}

export function listDestinationFolders(tree: WorkspaceNode[]): DestinationFolder[] {
  const active = availableTree(tree, false);
  const folders: DestinationFolder[] = [];

  function visit(nodes: WorkspaceNode[], prefix: string) {
    for (const node of nodes) {
      if (node.kind !== 'folder') continue;
      const path = prefix ? `${prefix} / ${node.name}` : node.name;
      folders.push({ id: node.id, name: node.name, path });
      visit(node.children ?? [], path);
    }
  }

  visit(active, '');
  return folders;
}

export function findFolderAncestorIds(tree: WorkspaceNode[], folderId: string): string[] | null {
  const active = availableTree(tree, false);

  function visit(nodes: WorkspaceNode[], ancestors: string[]): string[] | null {
    for (const node of nodes) {
      if (node.kind !== 'folder') continue;
      const trail = [...ancestors, node.id];
      if (node.id === folderId) return trail;
      const nested = visit(node.children ?? [], trail);
      if (nested) return nested;
    }
    return null;
  }

  return visit(active, []);
}

export function extractTemplateAttachmentIds(content: string): string[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(attachmentReferencePattern)) {
    ids.add(match[1].toLowerCase());
  }
  return [...ids];
}

function findDestinationSiblings(
  tree: WorkspaceNode[],
  destinationFolderId: string | null,
): { siblings: WorkspaceNode[]; path: string } | null {
  if (destinationFolderId === null) {
    return {
      siblings: tree.filter((node) => node.status !== 'trashed'),
      path: 'Workspaces',
    };
  }
  const activeFolder = listDestinationFolders(tree).find((folder) => folder.id === destinationFolderId);
  if (!activeFolder) return null;

  function findRawChildren(nodes: WorkspaceNode[]): WorkspaceNode[] | null {
    for (const node of nodes) {
      if (node.id === destinationFolderId && node.kind === 'folder') {
        return (node.children ?? []).filter((child) => child.status !== 'trashed');
      }
      if (node.children) {
        const nested = findRawChildren(node.children);
        if (nested) return nested;
      }
    }
    return null;
  }

  const siblings = findRawChildren(tree);
  return siblings ? { siblings, path: activeFolder.path } : null;
}

export function resolveTemplateNotePlan({
  templateName,
  rawName,
  destinationFolderId,
  tree,
}: {
  templateName: string;
  rawName: string;
  destinationFolderId: string | null;
  tree: WorkspaceNode[];
}): TemplateNotePlan {
  const destination = findDestinationSiblings(tree, destinationFolderId);
  const destinationPath = destination?.path ?? 'Workspaces';
  const trimmed = rawName.trim();

  if (!trimmed) {
    return {
      valid: false,
      error: 'Enter a note name.',
      requestedName: '',
      resolvedName: '',
      collided: false,
      destinationPath,
    };
  }

  if (forbiddenNameChars.test(trimmed)) {
    return {
      valid: false,
      error: 'Note names cannot contain /, \\, [, ], |, or control characters.',
      requestedName: trimmed,
      resolvedName: trimmed,
      collided: false,
      destinationPath,
    };
  }

  if (trimmed.length > maxNoteNameLength) {
    return {
      valid: false,
      error: `Note name must be ${maxNoteNameLength} characters or fewer.`,
      requestedName: trimmed,
      resolvedName: trimmed,
      collided: false,
      destinationPath,
    };
  }

  const defaultExt = templateExtension(templateName);
  const explicitExt = trimmed.match(noteExtensionPattern)?.[0];
  const requestedName = explicitExt ? trimmed : `${trimmed}${defaultExt}`;
  const appliedExt = explicitExt ?? defaultExt;
  const stem = requestedName.slice(0, -appliedExt.length);

  if (!stem.trim()) {
    return {
      valid: false,
      error: 'Enter a name before the file extension.',
      requestedName,
      resolvedName: requestedName,
      collided: false,
      destinationPath,
    };
  }

  if (stem === '.' || stem === '..' || trimmed === '.' || trimmed === '..') {
    return {
      valid: false,
      error: 'Enter a valid note name.',
      requestedName,
      resolvedName: requestedName,
      collided: false,
      destinationPath,
    };
  }

  if (!destination) {
    return {
      valid: false,
      error: 'Choose an existing destination folder.',
      requestedName,
      resolvedName: requestedName,
      collided: false,
      destinationPath,
    };
  }

  const existing = new Set(destination.siblings.map((sibling) => nameKey(sibling.name)));
  if (!existing.has(nameKey(requestedName))) {
    return {
      valid: true,
      requestedName,
      resolvedName: requestedName,
      collided: false,
      destinationPath,
    };
  }

  let suffix = 2;
  let candidate = `${stem} (${suffix})${appliedExt}`;
  while (existing.has(nameKey(candidate))) {
    suffix += 1;
    candidate = `${stem} (${suffix})${appliedExt}`;
  }

  return {
    valid: true,
    requestedName,
    resolvedName: candidate,
    collided: true,
    destinationPath,
  };
}

export function defaultTemplateNoteName(
  templateName: string,
  destinationFolderId: string | null,
  tree: WorkspaceNode[],
): string {
  const match = templateName.match(noteExtensionPattern);
  const ext = match?.[0] ?? '.md';
  const stem = match ? templateName.slice(0, -ext.length) : templateName;
  const baseSuggestion = `${stem || 'Untitled'} copy${ext}`;
  const plan = resolveTemplateNotePlan({
    templateName,
    rawName: baseSuggestion,
    destinationFolderId,
    tree,
  });
  return plan.valid ? plan.resolvedName : baseSuggestion;
}
