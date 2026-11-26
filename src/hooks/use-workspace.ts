import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  availableTree,
  ensureNoteExtension,
  find,
  getNoteFormat,
  insert,
  noteExtensionPattern,
  remove,
  update,
  type NoteProperty,
  type WorkspaceNode,
} from '@/lib/workspace-tree';
import { defaultTemplateNoteName, findFolderAncestorIds, resolveTemplateNotePlan } from '@/lib/template-note';
import { ambiguousWikiMatches, resolveWikiLink, wikiNoteLocation, wikiTarget, type WikiNote } from '@/lib/wiki-index';
import { notePreviewText, wikiLabel } from '@/lib/wiki-markdown';
import type { WikiLinkPreviewInfo } from '@/components/editor/wiki-link-preview';
import type { WikiCreateSuggestion } from '@/components/editor/wiki-suggestions';
import { noteTags, replaceNoteTags, tagKey, validTagName } from '@/lib/note-tags';
import { buildWorkspaceTags, planTagMutation, type TagMutation } from '@/lib/workspace-tags';
import { buildWorkspaceSearch } from '@/lib/workspace-search';
import { destinationSiblings, locateWorkspaceNode, moveWorkspaceNode, nameConflict } from '@/lib/workspace-mutation';
import { planMarkdownImport, planMarkdownExport, type ImportBatch, type ImportChoice } from '@/lib/markdown-transfer';
import { useWorkspaceFeedback } from './use-workspace-feedback';
import { useWorkspacePersistence } from './use-workspace-persistence';

function folderDisplayPath(nodes: WorkspaceNode[], folderId: string, prefix = ''): string | null {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue;
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.id === folderId) return path;
    const nested = node.children && folderDisplayPath(node.children, folderId, path);
    if (nested) return nested;
  }
  return null;
}

export type CreateFromTemplateOptions = {
  name?: string;
  parentId?: string | null;
};

export function useWorkspace() {
  const {
    tree, wiki, managedTags, applyTagState, setTree, updateNote, tabSession, setTabSession, expanded, setExpanded,
    saveStatus, saveWorkspace, flushWorkspace, reloadWorkspace, restoreVersion, recoverySnapshot, loading,
  } = useWorkspacePersistence();
  const { active, openFiles, pinnedFiles } = tabSession;
  const visibleTree = useMemo(() => availableTree(tree), [tree]);
  const searchIndex = useMemo(() => buildWorkspaceSearch(tree, managedTags), [tree, managedTags]);
  const tagCatalog = useMemo(() => buildWorkspaceTags(tree, managedTags), [tree, managedTags]);
  const [draft, setDraft] = useState<{ parent: string | null; kind: WorkspaceNode['kind'] } | null>(null);
  const [draftName, setDraftName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const { latestTree, notify, afterSave } = useWorkspaceFeedback(tree, flushWorkspace, saveStatus === 'saved', managedTags);
  const latestReversibleChange = useRef(new Map<string, symbol>());

  function mutationError(message: string) {
    notify({ key: 'workspace-mutation-validation', kind: 'error', message });
  }

  function createWorkspaceNote(node: WorkspaceNode, parent: string | null) {
    setTree((nodes) => insert(nodes, parent, node));
    afterSave({
      key: `created:${node.id}`, message: node.kind === 'folder' ? 'Folder created.' : 'Note created.',
      applies: (nodes) => Boolean(find(nodes, node.id)),
    });
  }

  function importMarkdownBatch(batch: ImportBatch, destination: string | null, choice: ImportChoice) {
    const plan = planMarkdownImport(latestTree.current, destination, batch, choice);
    if (plan.imported.length || plan.folderCount) {
      setTree(() => plan.tree);
      if (destination) setExpanded((ids) => ids.includes(destination) ? ids : [...ids, destination]);
    }
    return plan;
  }

  function replaceImportedMarkdown(id: string, original: string, content: string) {
    if (find(latestTree.current, id)?.content !== original) return false;
    updateNote(id, (note) => ({ ...note, content }), content);
    return true;
  }

  function prepareMarkdownExport(selection: string | string[] | null, includeTrash: boolean) {
    return planMarkdownExport(latestTree.current, selection, includeTrash);
  }

  function downloadWorkspaceCopy(original = false) {
    const snapshot = original ? recoverySnapshot : JSON.stringify(tree, null, 2);
    if (snapshot === null) return;
    const url = URL.createObjectURL(new Blob([snapshot], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = original ? 'kanso-workspace-recovery.json' : 'kanso-workspace-unsaved.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const openFile = (id: string) => {
    if (!searchIndex.notes.has(id)) return;
    activateFile(id);
    const lastOpenedAt = Date.now();
    updateNote(id, (node) => ({ ...node, lastOpenedAt }));
  };

  function activateFile(id: string) {
    setTabSession((session) => session.active === id ? session : {
      ...session, active: id,
      openFiles: session.openFiles.includes(id) ? session.openFiles : [...session.openFiles, id],
    });
  }

  function closeFiles(shouldClose: (id: string, index: number, files: string[], pinned: string[]) => boolean) {
    setTabSession((session) => {
      const remaining = session.openFiles.filter((id, index, files) => !shouldClose(id, index, files, session.pinnedFiles));
      if (remaining.length === session.openFiles.length) return session;
      const remainingIds = new Set(remaining);
      const activeIndex = session.openFiles.indexOf(session.active);
      const nextActive = session.openFiles.slice(activeIndex + 1).find((id) => remainingIds.has(id))
        ?? session.openFiles.slice(0, activeIndex).reverse().find((id) => remainingIds.has(id));
      return {
        active: remainingIds.has(session.active) ? session.active : nextActive ?? remaining[0] ?? '',
        openFiles: remaining,
        pinnedFiles: session.pinnedFiles.filter((id) => remainingIds.has(id)),
      };
    });
  }

  function closeFile(id: string) {
    closeFiles((file) => file === id);
  }

  function closeOtherFiles(id: string) {
    closeFiles((file, _index, files, pins) => files.includes(id) && file !== id && !pins.includes(file));
  }

  function closeFilesToRight(id: string) {
    closeFiles((file, index, files, pins) => {
      const target = files.indexOf(id);
      return target !== -1 && index > target && !pins.includes(file);
    });
  }

  function toggleFilePin(id: string) {
    setTabSession((session) => {
      if (!session.openFiles.includes(id)) return session;
      const pinnedFiles = session.pinnedFiles.includes(id)
        ? session.pinnedFiles.filter((file) => file !== id) : [...session.pinnedFiles, id];
      return { ...session, pinnedFiles };
    });
  }

  function reorderFile(id: string, targetId: string) {
    setTabSession((session) => {
      const from = session.openFiles.indexOf(id);
      const to = session.openFiles.indexOf(targetId);
      if (from === -1 || to === -1 || from === to) return session;
      const openFiles = [...session.openFiles];
      openFiles.splice(from, 1);
      openFiles.splice(to, 0, id);
      return { ...session, openFiles };
    });
  }

  function cycleFile(direction: -1 | 1) {
    const index = openFiles.indexOf(active);
    if (openFiles.length < 2 || index === -1) return false;
    openFile(openFiles[(index + direction + openFiles.length) % openFiles.length]);
    return true;
  }

  const begin = (parent: string | null, kind: 'file' | 'folder') => {
    if (loading || saveStatus === 'unavailable') return;
    setDraft({ parent, kind });
    setDraftName(kind === 'file' ? 'Untitled.md' : 'New folder');
    if (parent) setExpanded((e) => (e.includes(parent) ? e : [...e, parent]));
  };
  const commit = () => {
    const name = draftName.trim();
    if (!draft || !name) {
      setDraft(null);
      return;
    }
    const node: WorkspaceNode = {
      id: crypto.randomUUID(),
      name: draft.kind === 'folder' ? name : ensureNoteExtension(name),
      kind: draft.kind,
      content: '',
      lastOpenedAt: draft.kind === 'file' ? Date.now() : undefined,
      children: draft.kind === 'folder' ? [] : undefined,
    };
    const siblings = destinationSiblings(latestTree.current, draft.parent);
    if (!siblings || nameConflict(siblings, node.name)) {
      mutationError(siblings ? 'That name is already used in this folder. Enter another name.' : 'The destination folder is unavailable.');
      return;
    }
    createWorkspaceNote(node, draft.parent);
    if (node.kind === 'file') {
      activateFile(node.id);
    }
    setDraft(null);
  };
  const rename = (id: string, name: string) => {
    const entry = locateWorkspaceNode(latestTree.current, id);
    const trimmed = name.trim();
    if (!entry || !trimmed) {
      setRenaming(null);
      return;
    }
    const nextName = entry.node.kind === 'file' ? ensureNoteExtension(trimmed) : trimmed;
    if (nextName === entry.node.name) {
      setRenaming(null);
      return;
    }
    const siblings = destinationSiblings(latestTree.current, entry.parent, true);
    if (!siblings || nameConflict(siblings, nextName, id)) {
      mutationError('Rename failed. Choose a name that is available in this folder.');
      return;
    }
    setTree((nodes) => update(nodes, id, (node) => ({ ...node, name: nextName })));
    afterSave({ key: `renamed:${id}`, message: `Renamed to “${nextName}”.`, applies: (nodes) => find(nodes, id)?.name === nextName });
    setRenaming(null);
  };

  function reversibleChange(id: string, description: string, apply: (nodes: WorkspaceNode[]) => WorkspaceNode[],
    stillApplied: (nodes: WorkspaceNode[]) => boolean,
    reverse: (nodes: WorkspaceNode[]) => WorkspaceNode[] | null) {
    const original = locateWorkspaceNode(latestTree.current, id);
    if (!original) return;
    const key = `workspace-change:${id}`;
    const change = Symbol();
    latestReversibleChange.current.set(id, change);
    const applies = (nodes: WorkspaceNode[]) => latestReversibleChange.current.get(id) === change && stillApplied(nodes);
    setTree(apply);
    afterSave({
      key, message: description, applies,
      undo() {
        const nodes = latestTree.current;
        if (!applies(nodes) || !reverse(nodes)) {
          mutationError('Undo is unavailable. The item or its destination changed.');
          return;
        }
        latestReversibleChange.current.delete(id);
        setTree((current) => stillApplied(current) ? reverse(current) ?? current : current);
        afterSave({
          key, message: 'Workspace change undone.', applies: (current) => {
            const restored = locateWorkspaceNode(current, id);
            return restored?.parent === original.parent && restored.node.status === original.node.status;
          },
        });
      },
    });
  }

  const move = (id: string, parent: string | null) => {
    if (!id) return;
    const nodes = latestTree.current;
    const entry = locateWorkspaceNode(nodes, id);
    if (!entry || entry.parent === parent) return;
    const siblings = destinationSiblings(nodes, parent);
    if (entry.status || !siblings || id === parent || (parent !== null && find(entry.node.children ?? [], parent))) {
      mutationError('Move failed. Choose an available folder outside the item.');
      return;
    }
    if (nameConflict(siblings, entry.node.name)) {
      mutationError('Move failed. That name is already used in the destination folder.');
      return;
    }
    reversibleChange(id, `Moved “${entry.node.name}”.`,
      (current) => moveWorkspaceNode(current, id, parent),
      (current) => {
        const moved = locateWorkspaceNode(current, id);
        return moved?.parent === parent && !moved.status;
      },
      (current) => {
        const moved = locateWorkspaceNode(current, id);
        const originalSiblings = destinationSiblings(current, entry.parent);
        if (!moved || !originalSiblings || nameConflict(originalSiblings, moved.node.name, id)
          || (entry.parent !== null && find(moved.node.children ?? [], entry.parent))) return null;
        return moveWorkspaceNode(current, id, entry.parent, entry.index);
      });
    if (parent) setExpanded((e) => (e.includes(parent) ? e : [...e, parent]));
  };
  const activeNode = searchIndex.notes.get(active)?.note;

  function closeNodeFiles(node: WorkspaceNode) {
    const contains = (id: string) => node.id === id || Boolean(find(node.children ?? [], id));
    closeFiles((id) => contains(id) || !searchIndex.notes.has(id));
  }

  function changeNodeStatus(id: string, status: WorkspaceNode['status']) {
    const entry = locateWorkspaceNode(latestTree.current, id);
    if (!entry || entry.node.status === status) return;
    const originalStatus = entry.node.status;
    if (!status) {
      const siblings = destinationSiblings(latestTree.current, entry.parent, true);
      if (!siblings || nameConflict(siblings, entry.node.name, id)) {
        mutationError('Restore failed. The original folder or name is unavailable.');
        return;
      }
    }
    const setStatus = (nodes: WorkspaceNode[], nextStatus: WorkspaceNode['status']) =>
      update(nodes, id, (node) => ({ ...node, status: nextStatus }));
    const applies = (nodes: WorkspaceNode[]) => {
      const current = locateWorkspaceNode(nodes, id);
      return current !== undefined && current.parent === entry.parent && current.node.status === status;
    };
    if (status) {
      reversibleChange(id, status === 'archived' ? `Archived “${entry.node.name}”.` : `Moved “${entry.node.name}” to Trash.`,
        (nodes) => setStatus(nodes, status), applies,
        (nodes) => {
          const current = locateWorkspaceNode(nodes, id);
          const siblings = destinationSiblings(nodes, entry.parent, true);
          if (!current || !siblings || (originalStatus !== 'trashed' && nameConflict(siblings, current.node.name, id))) return null;
          return setStatus(nodes, originalStatus);
        });
      closeNodeFiles(entry.node);
    } else {
      latestReversibleChange.current.delete(id);
      setTree((nodes) => setStatus(nodes, undefined));
      afterSave({ key: `workspace-change:${id}`, message: `Restored “${entry.node.name}”.`, applies });
    }
  }

  function deletePermanently(id: string) {
    const node = find(latestTree.current, id);
    if (node?.status !== 'trashed' || !confirm(`Permanently delete “${node.name}” and its contents?`)) return;
    latestReversibleChange.current.delete(id);
    setTree((nodes) => remove(nodes, id));
    closeNodeFiles(node);
    afterSave({ key: `workspace-change:${id}`, message: `Permanently deleted “${node.name}”.`, applies: (nodes) => !find(nodes, id) });
  }

  function toggleNoteFlag(id: string, flag: 'starred' | 'template') {
    const note = find(latestTree.current, id);
    if (note?.kind !== 'file') return;
    const enabled = !note[flag];
    updateNote(id, (node) => (
      node.kind === 'file' ? { ...node, [flag]: enabled } : node
    ));
    if (flag === 'starred') {
      afterSave({
        key: `starred:${id}`, message: `${enabled ? 'Starred' : 'Unstarred'} “${note.name}”.`,
        applies: (nodes) => find(nodes, id)?.starred === enabled,
      });
    }
  }

  function createFromTemplate(id: string, options: CreateFromTemplateOptions = {}) {
    const template = find(visibleTree, id);
    if (!template?.template) return null;
    const destinationParentId = options.parentId ?? null;
    const plan = resolveTemplateNotePlan({
      templateName: template.name,
      rawName: options.name ?? defaultTemplateNoteName(template.name, destinationParentId, tree),
      destinationFolderId: destinationParentId,
      tree,
    });
    if (!plan.valid) return null;

    const ancestorIds = destinationParentId === null ? [] : findFolderAncestorIds(visibleTree, destinationParentId);
    if (ancestorIds === null) return null;

    const note: WorkspaceNode = {
      id: crypto.randomUUID(),
      kind: 'file',
      name: plan.resolvedName,
      content: template.content ?? '',
      properties: template.properties?.map((property) => ({ ...property })),
      lastOpenedAt: Date.now(),
    };
    createWorkspaceNote(note, destinationParentId);
    if (ancestorIds.length > 0) {
      setExpanded((current) => [...new Set([...current, ...ancestorIds])]);
    }
    activateFile(note.id);
    return note;
  }

  const changeContent = (content: string) => {
    updateNote(active, (node) => ({ ...node, content }), content);
  };

  function changeProperties(properties: NoteProperty[]) {
    updateNote(active, (node) => ({ ...node, properties }));
  }

  function changeNoteTags(values: string[]) {
    const note = find(latestTree.current, active);
    if (!note || values.some((tag) => !validTagName(tag))) return false;
    const canonical = values.map((tag) => tagCatalog.get(tagKey(tag))?.name ?? tag.trim());
    const next = replaceNoteTags(note, canonical);
    if (!next) {
      mutationError('Edit the YAML tags in Source Mode before changing these tags.');
      return false;
    }
    applyTagState(({ tree, managed }) => {
      const current = find(tree, active);
      if (!current) return null;
      const updated = current === note ? next : replaceNoteTags(current, canonical);
      return updated ? { tree: update(tree, active, () => updated), managed } : null;
    });
    afterSave({ key: `note-tags:${active}`, message: 'Note tags updated.', applies: (nodes) => {
      const updated = find(nodes, active);
      return !!updated && JSON.stringify(noteTags(updated)) === JSON.stringify(noteTags(next));
    } });
    return true;
  }

  function mutateTags(mutation: TagMutation) {
    const originalTree = latestTree.current;
    const plan = planTagMutation(originalTree, managedTags, mutation);
    if ('error' in plan) {
      mutationError(plan.error);
      return false;
    }
    applyTagState((current) => {
      if (current.tree === originalTree && current.managed === managedTags) return plan;
      const refreshed = planTagMutation(current.tree, current.managed, mutation);
      return 'error' in refreshed ? null : refreshed;
    });
    const targetName = mutation.name?.trim() ?? '';
    const targetKey = tagKey(targetName);
    const action = { create: 'created', rename: 'renamed', merge: 'merged', remove: 'removed' }[mutation.kind];
    afterSave({ key: 'workspace-tags', message: `Tag ${action}.`, applies: (nodes, retained) => {
      const next = buildWorkspaceTags(nodes, retained);
      const sourceGone = !mutation.source || mutation.source === targetKey || !next.has(mutation.source);
      if (mutation.kind === 'remove') return sourceGone;
      if (mutation.kind === 'merge') return sourceGone && next.has(targetKey);
      return sourceGone && next.get(targetKey)?.name === targetName;
    } });
    return true;
  }

  const pendingCreatedWikiTargets = useRef<Map<string, string>>(new Map());
  useLayoutEffect(() => {
    pendingCreatedWikiTargets.current.clear();
  }, [tree]);

  const wikiSuggestions = useMemo(() => Array.from(wiki.catalog.notes.values())
    .flatMap((note) => {
      const target = note.active ? wikiTarget(wiki.catalog, note) : null;
      return target ? [{ ...note, target }] : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path)), [wiki.catalog]);

  function getWikiNote(target: string): WikiNote | undefined {
    const linked = wiki.outgoing.get(active)?.find((link) => link.target === target);
    return linked?.targetId ? wiki.catalog.notes.get(linked.targetId) : resolveWikiLink(wiki.catalog, target);
  }

  function canCreateWikiNote(target: string) {
    return Boolean(wikiNoteLocation(wiki.catalog, target));
  }

  function expandNoteAncestors(parentId: string | null) {
    if (!parentId) return;
    const ancestors = findFolderAncestorIds(visibleTree, parentId);
    setExpanded((folders) => [...new Set([...folders, ...(ancestors ?? [parentId])])]);
  }

  function describeCreateWikiNote(rawTarget: string): WikiCreateSuggestion | null {
    const trimmed = rawTarget.trim();
    if (!trimmed) return null;
    if (getWikiNote(trimmed) ?? resolveWikiLink(wiki.catalog, trimmed)) return null;
    if (ambiguousWikiMatches(wiki.catalog, trimmed).length > 0) return null;
    const location = wikiNoteLocation(wiki.catalog, trimmed);
    if (!location) return null;
    const siblings = destinationSiblings(latestTree.current, location.parent);
    if (!siblings || nameConflict(siblings, location.name)) return null;
    const folderPath = location.parent ? folderDisplayPath(latestTree.current, location.parent) : null;
    if (location.parent && !folderPath) return null;
    return {
      target: trimmed,
      name: location.name,
      path: folderPath ? `${folderPath}/${location.name}` : location.name,
    };
  }

  function createWikiNote(rawTarget: string): string | null {
    const trimmed = rawTarget.trim();
    if (!trimmed) return null;
    const existing = getWikiNote(trimmed) ?? resolveWikiLink(wiki.catalog, trimmed);
    if (existing) {
      return existing.active ? (wikiTarget(wiki.catalog, existing) ?? trimmed) : null;
    }
    if (ambiguousWikiMatches(wiki.catalog, trimmed).length > 0) return null;
    const location = wikiNoteLocation(wiki.catalog, trimmed);
    if (!location) return null;

    const noteStem = location.name.replace(noteExtensionPattern, '');
    const folderPath = location.parent ? folderDisplayPath(latestTree.current, location.parent) : null;
    if (location.parent && !folderPath) return null;

    const pendingKey = `${location.parent ?? 'root'}:${location.name.normalize('NFC').toLowerCase()}`;
    const pendingTarget = pendingCreatedWikiTargets.current.get(pendingKey);
    if (pendingTarget) return pendingTarget;

    const siblings = destinationSiblings(latestTree.current, location.parent);
    if (!siblings || nameConflict(siblings, location.name)) {
      mutationError('The linked note could not be created. Its destination or name is unavailable.');
      return null;
    }

    let insertedTarget = noteStem;
    if (folderPath) {
      insertedTarget = `${folderPath}/${noteStem}`;
    } else if (trimmed.startsWith('/')) {
      if (resolveWikiLink(wiki.catalog, noteStem) || ambiguousWikiMatches(wiki.catalog, noteStem).length > 0) {
        insertedTarget = `/${noteStem}`;
      }
    }

    const id = crypto.randomUUID();
    createWorkspaceNote({ id, name: location.name, kind: 'file', content: '', lastOpenedAt: Date.now() }, location.parent);
    expandNoteAncestors(location.parent);
    pendingCreatedWikiTargets.current.set(pendingKey, insertedTarget);
    return insertedTarget;
  }

  function previewWikiLink(rawTarget: string, alias: string | null = null): WikiLinkPreviewInfo {
    const trimmedTarget = rawTarget.trim();
    const cleanAlias = alias?.trim() || null;
    const note = getWikiNote(trimmedTarget) ?? resolveWikiLink(wiki.catalog, trimmedTarget);
    if (note) {
      const workspaceNote = find(tree, note.id);
      const snippet = workspaceNote
        ? notePreviewText(workspaceNote.content ?? '', getNoteFormat(note.path) === 'markdown')
        : '';
      return {
        target: trimmedTarget,
        alias: cleanAlias,
        status: note.active ? 'resolved' : 'inactive',
        title: note.name,
        path: note.path,
        snippet,
        canCreate: false,
      };
    }
    const matches = ambiguousWikiMatches(wiki.catalog, trimmedTarget);
    if (matches.length > 0) {
      return {
        target: trimmedTarget,
        alias: cleanAlias,
        status: 'ambiguous',
        title: wikiLabel(trimmedTarget),
        path: null,
        snippet: '',
        canCreate: false,
        matches: matches.map((match) => match.path),
      };
    }
    const location = wikiNoteLocation(wiki.catalog, trimmedTarget);
    return {
      target: trimmedTarget,
      alias: cleanAlias,
      status: 'missing',
      title: location ? location.name.replace(noteExtensionPattern, '') : wikiLabel(trimmedTarget),
      path: null,
      snippet: '',
      canCreate: Boolean(location),
    };
  }

  function followWikiLink(target: string) {
    const note = getWikiNote(target);
    if (note) {
      if (note.active) openFile(note.id);
      return;
    }
    const location = wikiNoteLocation(wiki.catalog, target);
    if (!location || !confirm(`Create a note named “${location.name}”?`)) return;
    const id = crypto.randomUUID();
    const siblings = destinationSiblings(latestTree.current, location.parent);
    if (!siblings || nameConflict(siblings, location.name)) {
      mutationError('The linked note could not be created. Its destination or name is unavailable.');
      return;
    }
    createWorkspaceNote({ id, name: location.name, kind: 'file', content: '', lastOpenedAt: Date.now() }, location.parent);
    expandNoteAncestors(location.parent);
    activateFile(id);
  }

  return {
    saveStatus, saveWorkspace, flushWorkspace, reloadWorkspace, restoreVersion, recoverySnapshot, downloadWorkspaceCopy, loading,
    importMarkdownBatch, replaceImportedMarkdown, prepareMarkdownExport,
    tagCatalog, mutateTags, changeNoteTags,
    wiki, wikiSuggestions, getWikiNote, canCreateWikiNote, describeCreateWikiNote, createWikiNote, previewWikiLink, followWikiLink, searchIndex,
    tree: visibleTree, allNodes: tree, activeNode, openFile, closeFile, expanded, setExpanded,
    closeOtherFiles, closeFilesToRight, toggleFilePin, reorderFile, cycleFile,
    files: openFiles.flatMap((id) => {
      const file = searchIndex.notes.get(id)?.note;
      return file ? [{ id, name: file.name, pinned: pinnedFiles.includes(id) }] : [];
    }),
    draft, draftName, setDraftName, cancelDraft: () => setDraft(null),
    begin, commit, rename, renaming, setRenaming, move, changeNodeStatus, deletePermanently, toggleNoteFlag, createFromTemplate, changeContent, changeProperties,
  };
}
