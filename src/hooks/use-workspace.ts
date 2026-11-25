import { useMemo, useState } from 'react';
import { availableTree, find, insert, remove, update, type NoteProperty, type WorkspaceNode } from '@/lib/workspace-tree';
import { resolveWikiLink, wikiNoteLocation, wikiTarget, type WikiNote } from '@/lib/wiki-index';
import { useWorkspacePersistence } from './use-workspace-persistence';

export function useWorkspace() {
  const {
    tree, wiki, setTree, updateNote, active, setActive, openFiles, setOpenFiles, expanded, setExpanded,
    saveStatus, saveWorkspace, recoverySnapshot, loading,
  } = useWorkspacePersistence();
  const visibleTree = useMemo(() => availableTree(tree), [tree]);
  const [draft, setDraft] = useState<{ parent: string | null; kind: WorkspaceNode['kind'] } | null>(null);
  const [draftName, setDraftName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);

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
    if (find(visibleTree, id)?.kind !== 'file') return;
    activateFile(id);
    const lastOpenedAt = Date.now();
    updateNote(id, (node) => ({ ...node, lastOpenedAt }));
  };

  function activateFile(id: string) {
    setActive(id);
    setOpenFiles((files) => files.includes(id) ? files : [...files, id]);
  }

  const closeFile = (id: string) => {
    const next = openFiles.filter((file) => file !== id);
    setOpenFiles(next);
    if (active === id) setActive(next[next.length - 1] ?? '');
  };

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
      name: /\.(?:md|txt|ya?ml)$/i.test(name) || draft.kind === 'folder' ? name : `${name}.md`,
      kind: draft.kind,
      content: '',
      lastOpenedAt: draft.kind === 'file' ? Date.now() : undefined,
      children: draft.kind === 'folder' ? [] : undefined,
    };
    setTree((t) => insert(t, draft.parent, node));
    if (node.kind === 'file') {
      activateFile(node.id);
    }
    setDraft(null);
  };
  const rename = (id: string, name: string) => {
    if (name.trim())
      setTree((t) =>
        update(t, id, (n) => ({
          ...n,
          name: n.kind === 'file' && !/\.(?:md|txt|ya?ml)$/i.test(name) ? `${name}.md` : name,
        })),
      );
    setRenaming(null);
  };
  const move = (id: string, parent: string | null) => {
    if (!find(visibleTree, id) || id === parent) return;
    if (parent !== null && find(visibleTree, parent)?.kind !== 'folder') return;
    setTree((nodes) => {
      const node = find(nodes, id);
      if (!node || (parent !== null && find(node.children ?? [], parent))) return nodes;
      return insert(remove(nodes, id), parent, node);
    });
    if (parent) setExpanded((e) => (e.includes(parent) ? e : [...e, parent]));
  };
  const activeNode = find(visibleTree, active);

  function closeNodeFiles(node: WorkspaceNode) {
    const contains = (id: string) => node.id === id || Boolean(find(node.children ?? [], id));
    const remainingFiles = openFiles.filter((id) => !contains(id) && find(visibleTree, id));
    setOpenFiles(remainingFiles);
    if (contains(active)) setActive(remainingFiles[remainingFiles.length - 1] ?? '');
  }

  function changeNodeStatus(id: string, status: WorkspaceNode['status']) {
    const node = find(tree, id);
    if (!node || node.status === status) return;
    setTree((nodes) => update(nodes, id, (entry) => ({ ...entry, status })));
    if (status) closeNodeFiles(node);
  }

  function deletePermanently(id: string) {
    const node = find(tree, id);
    if (node?.status !== 'trashed' || !confirm(`Permanently delete “${node.name}” and its contents?`)) return;
    setTree((nodes) => remove(nodes, id));
    closeNodeFiles(node);
  }

  function toggleNoteFlag(id: string, flag: 'starred' | 'template') {
    updateNote(id, (node) => (
      node.kind === 'file' ? { ...node, [flag]: !node[flag] } : node
    ));
  }

  function createFromTemplate(id: string) {
    const template = find(visibleTree, id);
    if (!template?.template) return;
    const extension = template.name.match(/\.(md|txt|ya?ml)$/i)?.[0];
    const baseName = extension ? template.name.slice(0, -extension.length) : template.name;
    const note: WorkspaceNode = {
      id: crypto.randomUUID(),
      kind: 'file',
      name: `${baseName} copy${extension ?? '.md'}`,
      content: template.content,
      properties: template.properties?.map((property) => ({ ...property })),
      lastOpenedAt: Date.now(),
    };
    setTree((nodes) => insert(nodes, null, note));
    activateFile(note.id);
  }

  const changeContent = (content: string) => {
    updateNote(active, (node) => ({ ...node, content }), content);
  };

  function changeProperties(properties: NoteProperty[]) {
    updateNote(active, (node) => ({ ...node, properties }));
  }

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

  function followWikiLink(target: string) {
    const note = getWikiNote(target);
    if (note) {
      if (note.active) openFile(note.id);
      return;
    }
    const location = wikiNoteLocation(wiki.catalog, target);
    if (!location || !confirm(`Create a note named “${location.name}”?`)) return;
    const id = crypto.randomUUID();
    setTree((nodes) => insert(nodes, location.parent, {
      id, name: location.name, kind: 'file', content: '', lastOpenedAt: Date.now(),
    }));
    if (location.parent) setExpanded((folders) => [...new Set([...folders, location.parent!])]);
    activateFile(id);
  }

  return {
    saveStatus, saveWorkspace, recoverySnapshot, downloadWorkspaceCopy, loading,
    wiki, wikiSuggestions, getWikiNote, canCreateWikiNote, followWikiLink,
    tree: visibleTree, allNodes: tree, activeNode, openFile, closeFile, expanded, setExpanded,
    files: openFiles.flatMap((id) => {
      const file = find(visibleTree, id);
      return file?.kind === 'file' ? [file] : [];
    }),
    draft, draftName, setDraftName, cancelDraft: () => setDraft(null),
    begin, commit, rename, renaming, setRenaming, move, changeNodeStatus, deletePermanently, toggleNoteFlag, createFromTemplate, changeContent, changeProperties,
  };
}
