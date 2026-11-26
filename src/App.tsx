import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { EditorHeader, EditorWorkspace, type EditorWorkspaceHandle } from '@/components/editor';
import { LeftSidebar } from '@/components/left-sidebar';
import { RightSidebar } from '@/components/right-sidebar';
import { Button } from '@/components/ui/button';
import { find, isSourceOnlyNote } from '@/lib/workspace-tree';
import { defaultSettings, updateSettings, useSettings } from '@/lib/settings';
import { useWorkspace } from '@/hooks/use-workspace';
import { isCurrentSearchResult, type SearchResult } from '@/lib/workspace-search';
import { tagKey } from '@/lib/note-tags';
import { CommandPalette } from '@/components/command-palette/command-palette';
import { MarkdownTransferDialog, type MarkdownTransferRequest } from '@/components/markdown-transfer/markdown-transfer-dialog';
import { executeWorkspaceCommand, matchWorkspaceShortcut, workspaceShortcuts, type WorkspaceCommand } from '@/lib/workspace-commands';

export default function App() {
  const workspace = useWorkspace();
  const rightSidebarToggleRef = useRef<HTMLButtonElement>(null);
  const editorWorkspaceRef = useRef<EditorWorkspaceHandle>(null);
  const workspaceSearchInput = useRef<HTMLInputElement>(null);
  const paletteReturnFocus = useRef<HTMLElement>(null);
  const transferReturnFocus = useRef<HTMLElement>(null);
  const { editorView: view, leftSidebarCollapsed: collapsed, focusModeShortcut } = useSettings();
  const sourceOnly = isSourceOnlyNote(workspace.activeNode?.name ?? '');
  const editorView = sourceOnly ? 'source' : view;
  const { saveStatus, recoverySnapshot } = workspace;
  const hasSaveIssue = saveStatus === 'failed' || saveStatus === 'conflict' || saveStatus === 'unavailable';
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [transfer, setTransfer] = useState<MarkdownTransferRequest | null>(null);
  const [revealRequest, setRevealRequest] = useState<{ id: string } | null>(null);

  const [linkJump, setLinkJump] = useState<{ id: string; offset: number; end?: number; content?: string } | null>(null);

  function openLinkedNote(id: string, offset?: number) {
    workspace.openFile(id);
    setLinkJump(offset === undefined ? null : { id, offset });
  }

  function openSearchResult(result: SearchResult) {
    if (!isCurrentSearchResult(workspace.searchIndex, result)) return false;
    const { entry, range } = result;
    workspace.openFile(entry.note.id);
    setLinkJump(range ? { id: entry.note.id, offset: range.start, end: range.end, content: entry.note.content } : null);
    setMobileOpen(false);
    return true;
  }

  useLayoutEffect(() => {
    if (!linkJump || workspace.activeNode?.id !== linkJump.id) return;
    const content = workspace.activeNode.content;
    // A newly opened note mounts its editor before accepting the pending selection.
    const frame = requestAnimationFrame(() => {
      if (linkJump.end === undefined || content === linkJump.content) {
        editorWorkspaceRef.current?.navigateToOffset(linkJump.offset, linkJump.end);
      }
      setLinkJump(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [linkJump, workspace.activeNode]);

  function revealExplorer() {
    if (window.matchMedia('(width < 40rem)').matches) setMobileOpen(true);
    else updateSettings({ leftSidebarCollapsed: false });
  }

  function revealExplorerNode(id: string) {
    revealExplorer();
    setRevealRequest({ id });
  }

  function createWorkspaceItem(kind: 'file' | 'folder') {
    revealExplorer();
    workspace.begin(null, kind);
  }

  function createNote() {
    createWorkspaceItem('file');
  }

  function toggleFocusMode() {
    setFocusMode((focused) => {
      const next = !focused;
      requestAnimationFrame(() => editorWorkspaceRef.current?.focus());
      return next;
    });
  }

  function focusWorkspaceSearch() {
    revealExplorer();
    requestAnimationFrame(() => workspaceSearchInput.current?.focus());
  }

  function openPalette() {
    paletteReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPaletteOpen(true);
  }

  function openMarkdownTransfer(request: MarkdownTransferRequest) {
    if (transfer || workspace.loading) return;
    transferReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTransfer(request);
  }

  function openPaletteNote(id: string) {
    if (!workspace.searchIndex.notes.has(id)) return;
    openLinkedNote(id);
    setMobileOpen(false);
    requestAnimationFrame(() => editorWorkspaceRef.current?.focus());
  }

  const activeNote = workspace.activeNode;
  const graphNoteTags = useMemo(() => {
    const map = new Map<string, readonly string[]>();
    for (const [id, entry] of workspace.searchIndex.notes) {
      if (!entry.archived && entry.tags.length > 0) {
        map.set(id, entry.tags.map((name) => workspace.tagCatalog.get(tagKey(name))?.name ?? name));
      }
    }
    return map;
  }, [workspace.searchIndex, workspace.tagCatalog]);
  const activeLocation = activeNote && workspace.searchIndex.notes.get(activeNote.id);
  const editorLocation = activeLocation && {
    note: activeLocation.note,
    archived: activeLocation.archived,
    folders: activeLocation.folders.flatMap((id) => {
      const folder = workspace.searchIndex.folders.get(id);
      return folder ? [{ id, name: folder.name, path: folder.path }] : [];
    }),
  };
  const canMutate = () => !workspace.loading && saveStatus !== 'unavailable' && saveStatus !== 'conflict';
  const canCreate = () => canMutate() && !workspace.draft;
  const canChangeNote = () => canMutate() && Boolean(activeNote && !workspace.searchIndex.notes.get(activeNote.id)?.archived);
  const commands: WorkspaceCommand[] = [
    { id: 'search', label: 'Search workspace', keywords: 'explorer find', shortcut: workspaceShortcuts.search, run: focusWorkspaceSearch },
    { id: 'new-note', label: 'New note', keywords: 'create file', shortcut: workspaceShortcuts.newNote, available: canCreate, run: createNote },
    { id: 'new-folder', label: 'New folder', keywords: 'create directory', available: canCreate, run: () => createWorkspaceItem('folder') },
    { id: 'save', label: 'Save workspace', shortcut: workspaceShortcuts.save, run: workspace.saveWorkspace },
    ...(['light', 'dark', 'system'] as const).map((theme) => ({
      id: `theme-${theme}`, label: `Use ${theme} theme`, keywords: 'appearance color', run: () => updateSettings({ theme }),
    })),
    { id: 'explorer', label: 'Toggle explorer sidebar', keywords: 'left files', run: () => {
      if (window.matchMedia('(width < 40rem)').matches) setMobileOpen((open) => !open);
      else updateSettings({ leftSidebarCollapsed: !collapsed });
    } },
    { id: 'note-sidebar', label: 'Toggle note sidebar', keywords: 'right details outline', run: () => setRightSidebarOpen((open) => !open) },
    { id: 'graph', label: 'Open workspace graph', keywords: 'knowledge links network', run: () => {
      updateSettings({ sidebarPanel: 'graph' });
      setRightSidebarOpen(true);
      setGraphOpen(true);
    } },
    { id: 'focus-mode', label: focusMode ? 'Exit focus mode' : 'Enter focus mode', keywords: 'zen distraction free writing', shortcut: focusModeShortcut === 'mod-shift-f' ? 'Shift+F' : focusModeShortcut === 'mod-shift-z' ? 'Shift+Z' : undefined, available: () => Boolean(activeNote), run: toggleFocusMode },
    { id: 'settings', label: 'Open settings', keywords: 'preferences options', run: () => setSettingsOpen(true) },
    { id: 'import-markdown', label: 'Import Markdown', keywords: 'files folders portable',
      available: canCreate, run: () => openMarkdownTransfer({ mode: 'import', destination: null }) },
    { id: 'export-note', label: 'Export active note', keywords: 'markdown portable',
      available: () => Boolean(activeNote), run: () => { if (activeNote) openMarkdownTransfer({ mode: 'export', id: activeNote.id }); } },
    { id: 'export-folders', label: 'Export selected folders', keywords: 'markdown portable',
      available: () => workspace.tree.some((node) => node.kind === 'folder'),
      run: () => openMarkdownTransfer({ mode: 'export', id: null, chooseFolders: true }) },
    { id: 'export-workspace', label: 'Export workspace as Markdown', keywords: 'files folders portable',
      available: () => workspace.allNodes.length > 0, run: () => openMarkdownTransfer({ mode: 'export', id: null }) },
    { id: 'star', label: activeNote?.starred ? 'Unstar active note' : 'Star active note', keywords: 'favorite bookmark',
      available: canChangeNote, run: () => { if (activeNote) workspace.toggleNoteFlag(activeNote.id, 'starred'); } },
    { id: 'archive', label: 'Archive active note', available: canChangeNote,
      run: () => { if (activeNote) workspace.changeNodeStatus(activeNote.id, 'archived'); } },
  ];

  // Capture app shortcuts before CodeMirror can consume Ctrl+P, Ctrl+N, or Ctrl+K.
  const onWorkspaceShortcut = useEffectEvent((event: KeyboardEvent) => {
    const focusShortcutKey = focusModeShortcut === 'mod-shift-f' ? 'f' : focusModeShortcut === 'mod-shift-z' ? 'z' : null;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const dialogOrPopup = target?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [data-editor-popup], .tippy-box');
    if (focusShortcutKey && (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === focusShortcutKey && !event.altKey) {
      if (!dialogOrPopup && !paletteOpen && !settingsOpen && !graphOpen && !transfer) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !workspace.loading && activeNote) toggleFocusMode();
      }
      return;
    }
    const shortcut = matchWorkspaceShortcut(event);
    const command = shortcut === workspaceShortcuts.palette ? { id: 'palette', label: 'Command palette', run: openPalette }
      : commands.find((entry) => entry.shortcut === shortcut);
    if (!command) return;
    const dialog = event.target instanceof HTMLElement && event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]');
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && !workspace.loading && !dialog && !paletteOpen && !settingsOpen && !graphOpen && !transfer) executeWorkspaceCommand(command);
  });

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!event.defaultPrevented && event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Tab') {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[role="dialog"], [role="menu"]')) return;
      const editorFocused = target?.closest('#editor-workspace');
      const tabFocused = target?.closest('[aria-label="Open files"]');
      if (workspace.cycleFile(event.shiftKey ? -1 : 1)) {
        event.preventDefault();
        requestAnimationFrame(() => {
          if (editorFocused) editorWorkspaceRef.current?.focus();
          else if (tabFocused) document.querySelector<HTMLElement>('[data-file-tab][aria-current="true"]')?.focus();
        });
      }
      return;
    }
    if (event.key === 'Escape' && !event.defaultPrevented && !paletteOpen && !settingsOpen && !graphOpen && !transfer) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [data-editor-popup], .tippy-box')) return;
      if (focusMode) { event.preventDefault(); setFocusMode(false); requestAnimationFrame(() => editorWorkspaceRef.current?.focus()); return; }
      setMobileOpen(false);
    }
  });

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => onShortcut(event);
    const handleWorkspaceKey = (event: KeyboardEvent) => onWorkspaceShortcut(event);
    window.addEventListener('keydown', handleKey);
    window.addEventListener('keydown', handleWorkspaceKey, true);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('keydown', handleWorkspaceKey, true);
    };
  }, []);

  return (
    <div inert={workspace.loading}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={(event) => { if (event.dataTransfer.files.length) event.preventDefault(); }}
      className={`relative flex h-dvh w-full min-w-0 gap-1.5 overflow-hidden bg-background p-1.5 font-sans text-foreground sm:gap-1 sm:p-1 ${focusMode ? 'gap-0 p-0 sm:gap-0 sm:p-0' : ''}`}>
      {!focusMode && collapsed && (
        <Button
          variant="ghost"
          size="icon"
          className="m-2 shrink-0 max-sm:hidden"
          title="Show explorer"
          aria-label="Show explorer"
          aria-controls="workspace-explorer"
          aria-expanded={false}
          onClick={revealExplorer}
        >
          <PanelLeftOpen />
        </Button>
      )}
      <LeftSidebar
        workspace={workspace}
        mobileOpen={mobileOpen}
        collapsed={collapsed || focusMode}
        searchInputRef={workspaceSearchInput}
        onMarkdownTransfer={openMarkdownTransfer}
        onOpenSearchResult={openSearchResult}
        onCreatedFromTemplate={() => {
          setMobileOpen(false);
          requestAnimationFrame(() => editorWorkspaceRef.current?.focus());
        }}
        revealRequest={revealRequest}
        onCollapse={() => {
          if (window.matchMedia('(width < 40rem)').matches) setMobileOpen(false);
          else updateSettings({ leftSidebarCollapsed: true });
        }}
      />
      <main className="isolate flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <EditorHeader
          files={workspace.files}
          hidden={focusMode}
          workspaceLoading={workspace.loading}
          workspaceSaved={workspace.saveStatus === 'saved' && workspace.recoverySnapshot === null}
          workspaceSaving={workspace.saveStatus === 'saving'}
          workspaceUnsaved={workspace.saveStatus === 'unsaved'}
          onSaveWorkspace={workspace.saveWorkspace}
          activeId={workspace.activeNode?.id ?? ''}
          location={editorLocation}
          onRevealLocation={revealExplorerNode}
          view={editorView}
          sourceOnly={sourceOnly}
          rightSidebarOpen={rightSidebarOpen}
          rightSidebarToggleRef={rightSidebarToggleRef}
          tabActions={{
            select: workspace.openFile,
            close: workspace.closeFile,
            closeOthers: workspace.closeOtherFiles,
            closeToRight: workspace.closeFilesToRight,
            togglePin: workspace.toggleFilePin,
            reorder: workspace.reorderFile,
            reveal: revealExplorerNode,
          }}
          onChangeView={(nextView) => {
            if (nextView === view) return;
            editorWorkspaceRef.current?.rememberSelection();
            updateSettings({ editorView: nextView });
          }}
          onPrepareAttachmentOperation={workspace.flushWorkspace}
          onReloadWorkspace={workspace.reloadWorkspace}
          onResetPreferences={() => {
            if (editorView !== defaultSettings.editorView) editorWorkspaceRef.current?.rememberSelection();
            updateSettings(defaultSettings);
          }}
          onToggleRightSidebar={() => setRightSidebarOpen((open) => !open)}
          onOpenExplorer={() => setMobileOpen(true)}
          settingsOpen={settingsOpen}
          onSettingsOpenChange={setSettingsOpen}
        />
        {(hasSaveIssue || recoverySnapshot !== null) && (
          <div className="shrink-0 border-b border-border bg-sidebar px-3 py-2 text-sm text-sidebar-foreground">
            <p role="status">
              {workspace.saveStatus === 'failed' && 'Changes could not be saved. Keep Kanso open and retry or download a copy.'}
              {workspace.saveStatus === 'conflict' && 'The saved workspace changed elsewhere. Download the notes JSON before reopening Kanso. It contains note text and metadata.'}
              {workspace.saveStatus === 'unavailable' && 'Workspace storage is unavailable. Retry opening the workspace.'}
              {!hasSaveIssue && recoverySnapshot !== null
                && 'Legacy workspace data remains available to download.'}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {workspace.saveStatus === 'failed' && <Button size="xs" onClick={workspace.saveWorkspace}>Retry save</Button>}
              {workspace.saveStatus === 'unavailable' && <Button size="xs" onClick={workspace.saveWorkspace}>Retry opening workspace</Button>}
              {(workspace.saveStatus === 'failed' || workspace.saveStatus === 'conflict') && (
                <Button size="xs" variant="outline" onClick={() => workspace.downloadWorkspaceCopy()}>Download notes JSON</Button>
              )}
              {workspace.recoverySnapshot !== null && (
                <Button size="xs" variant="outline" onClick={() => workspace.downloadWorkspaceCopy(true)}>Download original data</Button>
              )}
            </div>
          </div>
        )}
        {focusMode && <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-sidebar px-3 text-sm text-sidebar-foreground"><span role="status">Focus mode{workspace.saveStatus === 'saving' ? ' · Saving…' : workspace.saveStatus === 'saved' ? ' · Saved' : workspace.saveStatus === 'unsaved' ? ' · Unsaved changes' : ' · Save issue'}</span><div className="flex items-center gap-2">{(workspace.saveStatus === 'failed' || workspace.saveStatus === 'conflict') && <Button variant="outline" size="sm" onClick={workspace.saveWorkspace}>Retry save</Button>}<Button variant="outline" size="sm" aria-label="Exit focus mode" onClick={() => { setFocusMode(false); requestAnimationFrame(() => editorWorkspaceRef.current?.focus()); }}>Exit focus mode <span className="ml-2 text-xs text-muted-foreground">Esc</span></Button></div></div>}
        {(hasSaveIssue || recoverySnapshot !== null) && (focusMode && <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-foreground" role="status">{workspace.saveStatus === 'failed' ? 'Changes could not be saved. Retry from the command palette after leaving focus mode.' : workspace.saveStatus === 'conflict' ? 'Workspace save conflict. Your current text remains open.' : workspace.saveStatus === 'unavailable' ? 'Workspace storage is unavailable.' : 'Legacy workspace data is available to download.'}</div>)}
        <div className="@container flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 flex-1 overflow-hidden">
            <EditorWorkspace
              ref={editorWorkspaceRef}
              note={workspace.activeNode}
              view={editorView}
              wiki={{
                suggestions: workspace.wikiSuggestions,
                follow: workspace.followWikiLink,
                create: workspace.createWikiNote,
                describeCreate: workspace.describeCreateWikiNote,
                preview: workspace.previewWikiLink,
              }}
              onChangeContent={workspace.changeContent}
              onPrepareAttachment={workspace.flushWorkspace}
              onCreateNote={createNote}
            />
          </div>
          <RightSidebar
            open={rightSidebarOpen && !focusMode}
            graphOpen={graphOpen}
            onGraphOpenChange={setGraphOpen}
            onCollapse={() => {
              setRightSidebarOpen(false);
              rightSidebarToggleRef.current?.focus();
            }}
            note={workspace.activeNode}
            onRestoreVersion={workspace.restoreVersion}
            getNote={(id) => find(workspace.tree, id)}
            onNavigateHeading={(offset) => editorWorkspaceRef.current?.navigateToOffset(offset)}
            onChangeProperties={workspace.changeProperties}
            tagNames={[...workspace.tagCatalog.values()].map(({ name }) => name).sort((a, b) => a.localeCompare(b))}
            onChangeTags={workspace.changeNoteTags}
            onOpenNote={openLinkedNote}
            wiki={workspace.wiki}
            noteTags={graphNoteTags}
            onFollowWikiLink={workspace.followWikiLink}
            canCreateWikiNote={workspace.canCreateWikiNote}
          />
        </div>
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} returnFocus={paletteReturnFocus}
        commands={commands} notes={workspace.searchIndex.notes} openIds={workspace.files.map(({ id }) => id)} onOpenNote={openPaletteNote} />
      {transfer && <MarkdownTransferDialog request={transfer} workspace={workspace} returnFocus={transferReturnFocus}
        onClose={() => setTransfer(null)} />}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close explorer"
          className="fixed inset-0 z-5 bg-foreground/40 sm:hidden dark:bg-background/70"
          onClick={() => setMobileOpen(false)}
        />
      )}
    </div>
  );
}
