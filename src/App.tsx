import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { EditorHeader, EditorWorkspace, type EditorView, type EditorWorkspaceHandle } from '@/components/editor';
import { LeftSidebar } from '@/components/left-sidebar';
import { RightSidebar } from '@/components/right-sidebar';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/hooks/use-workspace';

export default function App() {
  const workspace = useWorkspace();
  const editorWorkspaceRef = useRef<EditorWorkspaceHandle>(null);
  const [view, setView] = useState<EditorView>(() => {
    try {
      return localStorage.getItem('kanso-view') === 'document' ? 'document' : 'source';
    } catch {
      return 'source';
    }
  });
  const sourceOnly = /\.ya?ml$/i.test(workspace.activeNode?.name ?? '');
  const editorView = sourceOnly ? 'source' : view;
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  function createNote() {
    if (window.matchMedia('(width < 40rem)').matches) setMobileOpen(true);
    setCollapsed(false);
    workspace.begin(null, 'file');
  }

  useEffect(() => {
    try {
      localStorage.setItem('kanso-view', view);
    } catch {
      // The view can still change for this session.
    }
  }, [view]);

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      createNote();
    }
    if (event.key === 'Escape' && !event.defaultPrevented) setMobileOpen(false);
  });

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <div className="relative flex h-dvh w-full min-w-0 gap-1.5 overflow-hidden bg-muted p-1.5 font-sans text-foreground sm:gap-1 sm:p-1">
      {collapsed && (
        <Button
          variant="ghost"
          size="icon"
          className="m-2 shrink-0 max-sm:hidden"
          title="Show explorer"
          aria-label="Show explorer"
          onClick={() => setCollapsed(false)}
        >
          <PanelLeftOpen />
        </Button>
      )}
      <LeftSidebar
        workspace={workspace}
        mobileOpen={mobileOpen}
        collapsed={collapsed}
        onReveal={() => {
          setCollapsed(false);
          if (window.matchMedia('(width < 40rem)').matches) setMobileOpen(true);
        }}
        onCollapse={() => {
          if (window.matchMedia('(width < 40rem)').matches) setMobileOpen(false);
          else setCollapsed(true);
        }}
      />
      <main className="isolate flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <EditorHeader
          files={workspace.files}
          workspaceSaved={workspace.saveStatus === 'saved' && workspace.recoverySnapshot === null}
          activeId={workspace.activeNode?.id ?? ''}
          view={editorView}
          sourceOnly={sourceOnly}
          rightSidebarOpen={rightSidebarOpen}
          onSelectFile={workspace.openFile}
          onCloseFile={workspace.closeFile}
          onChangeView={(nextView) => {
            if (nextView === view) return;
            editorWorkspaceRef.current?.rememberSelection();
            setView(nextView);
          }}
          onToggleRightSidebar={() => setRightSidebarOpen((open) => !open)}
          onOpenExplorer={() => setMobileOpen(true)}
        />
        {(workspace.recoverySnapshot !== null || workspace.saveStatus !== 'saved') && (
          <div className="shrink-0 border-b border-border bg-muted px-3 py-2 text-sm text-foreground">
            <p role="status">
              {workspace.saveStatus === 'failed' && 'Changes could not be saved. Keep Kanso open and retry or download a copy.'}
              {workspace.saveStatus === 'conflict' && 'The saved workspace changed elsewhere. Download this copy before reopening Kanso.'}
              {workspace.saveStatus === 'unavailable' && 'Workspace storage is unavailable. Download any changes before closing Kanso.'}
              {workspace.saveStatus === 'saved' && workspace.recoverySnapshot !== null
                && 'The saved workspace could not be read. A fresh workspace is open, and you can download the original data.'}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {workspace.saveStatus === 'failed' && <Button size="xs" onClick={workspace.saveWorkspace}>Retry save</Button>}
              {workspace.saveStatus !== 'saved' && (
                <Button size="xs" variant="outline" onClick={() => workspace.downloadWorkspaceCopy()}>Download workspace</Button>
              )}
              {workspace.recoverySnapshot !== null && (
                <Button size="xs" variant="outline" onClick={() => workspace.downloadWorkspaceCopy(true)}>Download original data</Button>
              )}
            </div>
          </div>
        )}
        <div className="@container flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 flex-1 overflow-hidden">
            <EditorWorkspace
              ref={editorWorkspaceRef}
              note={workspace.activeNode}
              view={editorView}
              onChangeContent={workspace.changeContent}
              onCreateNote={createNote}
            />
          </div>
          <RightSidebar
            open={rightSidebarOpen}
            note={workspace.activeNode}
            tree={workspace.tree}
            onNavigateHeading={(offset) => editorWorkspaceRef.current?.navigateToHeading(offset)}
            onChangeProperties={workspace.changeProperties}
            onOpenNote={workspace.openFile}
          />
        </div>
      </main>
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
