import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openWorkspaceDatabase, saveSnapshot } from '@/lib/database/workspace-database';
import { buildWikiIndex, editWikiIndex, refreshWikiStructure } from '@/lib/wiki-index';
import { update } from '@/lib/workspace-tree';
import type { WorkspaceSnapshot } from '@/lib/database/workspace-types';

type SaveStatus = 'saved' | 'failed' | 'conflict' | 'unavailable';

export function useWorkspacePersistence() {
  const [{ tree, wiki }, setWorkspace] = useState(() => ({ tree: [] as WorkspaceSnapshot['tree'], wiki: buildWikiIndex([]) }));
  function setTree(change: (tree: WorkspaceSnapshot['tree']) => WorkspaceSnapshot['tree']) {
    setWorkspace((previous) => {
      const next = change(previous.tree);
      return next === previous.tree ? previous : refreshWikiStructure(next, previous.wiki);
    });
  }
  function updateNote(id: string, change: Parameters<typeof update>[2], content?: string) {
    setWorkspace((previous) => ({
      tree: update(previous.tree, id, change),
      wiki: content === undefined ? previous.wiki : editWikiIndex(previous.wiki, id, content),
    }));
  }
  const [active, setActive] = useState('');
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [loading, setLoading] = useState(true);
  const [recoverySnapshot, setRecoverySnapshot] = useState<string | null>(null);
  const saved = useRef<{ snapshot: WorkspaceSnapshot; revision: number } | null>(null);
  const latest = useRef<WorkspaceSnapshot | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const snapshot = useMemo(() => ({ tree, wiki, active, openFiles, expanded }), [tree, wiki, active, openFiles, expanded]);

  const initialize = useCallback(async () => {
    setLoading(true);
    try {
      const workspace = await openWorkspaceDatabase();
      saved.current = workspace;
      setWorkspace({ tree: workspace.snapshot.tree, wiki: workspace.snapshot.wiki });
      setActive(workspace.snapshot.active);
      setOpenFiles(workspace.snapshot.openFiles);
      setExpanded(workspace.snapshot.expanded);
      setRecoverySnapshot(workspace.recoverySnapshot);
      setSaveStatus('saved');
    } catch (error) {
      console.error('Could not open the workspace database', error);
      setSaveStatus('unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void initialize(); }, [initialize]);

  const flush = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const previous = saved.current;
    const current = latest.current;
    if (!previous || !current || previous.snapshot === current) return Promise.resolve(true);
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
    if (previous.tree === tree && previous.wiki === wiki && previous.active === active && previous.openFiles === openFiles && previous.expanded === expanded) {
      saved.current.snapshot = snapshot;
    }
    latest.current = snapshot;
    void flush();
  }, [active, expanded, flush, loading, openFiles, snapshot, tree, wiki]);

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

  function saveWorkspace() {
    if (saved.current) void flush();
    else void initialize();
  }

  return {
    tree, wiki, setTree, updateNote, active, setActive, openFiles, setOpenFiles, expanded, setExpanded,
    saveStatus, saveWorkspace, recoverySnapshot, loading,
  };
}
