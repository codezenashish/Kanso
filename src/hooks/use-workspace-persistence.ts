import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { restoreNoteVersion } from '@/lib/database/history-database';
import { openWorkspaceDatabase, saveSnapshot } from '@/lib/database/workspace-database';
import { buildWikiIndex, editWikiIndex, refreshWikiStructure } from '@/lib/wiki-index';
import { update } from '@/lib/workspace-tree';
import type { TabSession, WorkspaceSnapshot } from '@/lib/database/workspace-types';

const autosaveInterval = 180;

type SaveStatus = 'unsaved' | 'saved' | 'saving' | 'failed' | 'conflict' | 'unavailable';

export type RestoreVersionResult = 'restored' | 'saveFailed' | 'conflict' | 'reloadFailed';

export function useWorkspacePersistence() {
  const [{ tree, wiki, managedTags }, setWorkspace] = useState(() => ({ tree: [] as WorkspaceSnapshot['tree'], wiki: buildWikiIndex([]), managedTags: [] as string[] }));
  function setTree(change: (tree: WorkspaceSnapshot['tree']) => WorkspaceSnapshot['tree']) {
    setWorkspace((previous) => {
      const next = change(previous.tree);
      return next === previous.tree ? previous : { ...previous, ...refreshWikiStructure(next, previous.wiki) };
    });
  }
  function updateNote(id: string, change: Parameters<typeof update>[2], content?: string) {
    setWorkspace((previous) => ({
      ...previous,
      tree: update(previous.tree, id, change),
      wiki: content === undefined ? previous.wiki : editWikiIndex(previous.wiki, id, content),
    }));
  }
  type TagState = { tree: WorkspaceSnapshot['tree']; managed: string[] };
  function applyTagState(change: (state: TagState) => TagState | null) {
    setWorkspace((previous) => {
      const next = change({ tree: previous.tree, managed: previous.managedTags });
      if (!next) return previous;
      return {
        tree: next.tree,
        wiki: next.tree === previous.tree ? previous.wiki : buildWikiIndex(next.tree),
        managedTags: next.managed,
      };
    });
  }
  const [tabSession, setTabSession] = useState<TabSession>({ active: '', openFiles: [], pinnedFiles: [] });
  const [expanded, setExpanded] = useState<string[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [loading, setLoading] = useState(true);
  const [recoverySnapshot, setRecoverySnapshot] = useState<string | null>(null);
  const saved = useRef<{ snapshot: WorkspaceSnapshot; revision: number } | null>(null);
  const latest = useRef<WorkspaceSnapshot | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshot = useMemo(() => ({ tree, wiki, managedTags, ...tabSession, expanded }), [tree, wiki, managedTags, tabSession, expanded]);

  const initialize = useCallback(async () => {
    setLoading(true);
    try {
      const workspace = await openWorkspaceDatabase();
      saved.current = workspace;
      setWorkspace({ tree: workspace.snapshot.tree, wiki: workspace.snapshot.wiki, managedTags: workspace.snapshot.managedTags });
      const { active, openFiles, pinnedFiles } = workspace.snapshot;
      setTabSession({ active, openFiles, pinnedFiles });
      setExpanded(workspace.snapshot.expanded);
      setRecoverySnapshot(workspace.recoverySnapshot);
      setSaveStatus('saved');
      return true;
    } catch (error) {
      console.error('Could not open the workspace database', error);
      setSaveStatus('unavailable');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void initialize(); }, [initialize]);

  const flush = useCallback((): Promise<boolean> => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (inFlight.current) return inFlight.current;
    const previous = saved.current;
    const current = latest.current;
    if (!previous || !current || previous.snapshot === current) return Promise.resolve(true);
    setSaveStatus('saving');
    inFlight.current = (async () => {
      let next = current;
      let revision = previous.revision;
      let persistedWiki = previous.snapshot.wiki;
      while (true) {
        try {
          const result = await saveSnapshot(next, revision, null, persistedWiki);
          if (result === null) {
            setSaveStatus('conflict');
            return false;
          }
          revision = result;
          persistedWiki = next.wiki;
          saved.current = { snapshot: next, revision };
        } catch (error) {
          console.error('Could not save the workspace', error);
          setSaveStatus('failed');
          return false;
        }
        if (!latest.current || next === latest.current) {
          setSaveStatus('saved');
          return true;
        }
        next = latest.current;
      }
    })().finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, []);

  useLayoutEffect(() => {
    if (loading || !saved.current) return;
    const previous = saved.current.snapshot;
    if (previous.tree === tree && previous.wiki === wiki && previous.managedTags === managedTags && previous.active === tabSession.active && previous.openFiles === tabSession.openFiles && previous.pinnedFiles === tabSession.pinnedFiles && previous.expanded === expanded) {
      saved.current.snapshot = snapshot;
    }
    latest.current = snapshot;
    if (saved.current.snapshot === snapshot || inFlight.current || saveTimer.current !== null) return;

    setSaveStatus((status) => status === 'failed' || status === 'conflict' ? status : 'unsaved');
    saveTimer.current = setTimeout(() => { void flush(); }, autosaveInterval);
  }, [expanded, flush, loading, managedTags, snapshot, tabSession, tree, wiki]);

  useLayoutEffect(() => () => {
    if (saveTimer.current !== null) void flush();
  }, [flush]);

  useEffect(() => {
    if (!isTauri()) return;
    const windowHandle = getCurrentWindow();
    let closing = false;
    const listener = windowHandle.onCloseRequested(async (event) => {
      event.preventDefault();
      if (closing) return;
      closing = true;
      try {
        if (await flush() || window.confirm('Changes could not be saved. Close Kanso and discard unsaved changes?')) {
          await windowHandle.destroy();
        }
      } catch (error) {
        console.error('Could not close the workspace window', error);
      } finally {
        closing = false;
      }
    });
    void listener.catch((error) => console.error('Could not register workspace close handler', error));
    return () => { void listener.then((unlisten) => unlisten(), () => undefined); };
  }, [flush]);

  async function restoreVersion(noteId: string, versionId: string): Promise<RestoreVersionResult> {
    if (!await flush() || !saved.current) return 'saveFailed';
    const restored = await restoreNoteVersion(noteId, versionId, saved.current.revision, true);
    if (restored === null) {
      setSaveStatus('conflict');
      return 'conflict';
    }
    saved.current = null;
    return await initialize() ? 'restored' : 'reloadFailed';
  }

  function saveWorkspace() {
    if (saved.current) {
      void flush();
    } else {
      void initialize();
    }
  }

  return {
    tree, wiki, managedTags, applyTagState, setTree, updateNote, tabSession, setTabSession, expanded, setExpanded,
    saveStatus, saveWorkspace, flushWorkspace: flush, reloadWorkspace: initialize, restoreVersion, recoverySnapshot, loading,
  };
}
