import type { Settings } from '@/lib/settings';
import type { Ref } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Braces, FileText, Minus, PanelLeftOpen, PanelRight, Square, X } from 'lucide-react';
import { SettingsDialog } from '@/components/settings/settings-dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FileTabs, type FileTabsProps } from './file-tabs';
import { EditorBreadcrumb, type EditorLocation } from './editor-breadcrumb';

export type EditorView = Settings['editorView'];

const windowActions = [
  ['minimize', 'Minimize window', Minus],
  ['toggleMaximize', 'Maximize or restore window', Square],
  ['close', 'Close window', X],
] as const;

type EditorHeaderProps = {
  hidden?: boolean;
  files: FileTabsProps['files'];
  activeId: string;
  location: EditorLocation | undefined;
  onRevealLocation: (id: string) => void;
  workspaceLoading: boolean;
  workspaceSaved: boolean;
  workspaceSaving: boolean;
  workspaceUnsaved: boolean;
  onSaveWorkspace: () => void;
  view: EditorView;
  rightSidebarOpen: boolean;
  rightSidebarToggleRef?: Ref<HTMLButtonElement>;
  sourceOnly: boolean;
  tabActions: FileTabsProps['actions'];
  onChangeView: (view: EditorView) => void;
  onResetPreferences: () => void;
  onPrepareAttachmentOperation: () => Promise<boolean>;
  onReloadWorkspace: () => Promise<boolean>;
  onToggleRightSidebar: () => void;
  onOpenExplorer: () => void;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
};

async function runWindowAction(action: (typeof windowActions)[number][0]) {
  try {
    await getCurrentWindow()[action]();
  } catch {
    // Window controls are only available inside Tauri.
  }
}

export function EditorHeader({
  hidden = false,
  files,
  activeId,
  location,
  onRevealLocation,
  workspaceLoading,
  workspaceSaved,
  workspaceSaving,
  workspaceUnsaved,
  onSaveWorkspace,
  view,
  rightSidebarOpen,
  rightSidebarToggleRef,
  sourceOnly,
  tabActions,
  onChangeView,
  onResetPreferences,
  onPrepareAttachmentOperation,
  onReloadWorkspace,
  onToggleRightSidebar,
  onOpenExplorer,
  settingsOpen,
  onSettingsOpenChange,
}: EditorHeaderProps) {
  const documentMode = view === 'document';
  const modeUnavailableReason = !activeId
    ? 'Open a note to switch editor modes'
    : sourceOnly
      ? 'YAML files use Source mode'
      : undefined;

  return (
    <header hidden={hidden} className="relative z-10 flex h-13 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2 text-sidebar-foreground sm:px-4">
      <Button
        variant="ghost"
        size="icon-sm"
        className="sm:hidden"
        aria-label="Show explorer"
        onClick={onOpenExplorer}
      >
        <PanelLeftOpen />
      </Button>
      <FileTabs files={files} activeId={activeId} actions={tabActions} />
      {location && <EditorBreadcrumb location={location} onReveal={onRevealLocation} />}
      <span role="status" className="sr-only lg:not-sr-only lg:w-28 lg:shrink-0 lg:truncate lg:text-xs lg:text-muted-foreground">
        {workspaceLoading ? 'Opening workspace…' : workspaceSaved ? 'Saved locally' : workspaceSaving ? 'Saving…' : workspaceUnsaved ? 'Unsaved changes' : 'Save issue'}
      </span>
      <Button variant="ghost" size="sm" className="hidden lg:inline-flex" onClick={onSaveWorkspace} disabled={workspaceLoading || workspaceSaved || workspaceSaving} title="Save workspace (Ctrl/Cmd+S)">Save</Button>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Document mode"
          aria-pressed={documentMode}
          aria-disabled={Boolean(modeUnavailableReason)}
          aria-controls={activeId ? 'editor-workspace' : undefined}
          title={
            modeUnavailableReason ??
            (documentMode ? 'Document mode · Switch to Source' : 'Source mode · Switch to Document')
          }
          className="cursor-pointer border-border text-sidebar-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-disabled:cursor-default aria-disabled:opacity-50"
          onClick={() => {
            if (!modeUnavailableReason) onChangeView(documentMode ? 'source' : 'document');
          }}
        >
          {documentMode ? <FileText aria-hidden="true" /> : <Braces aria-hidden="true" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          ref={rightSidebarToggleRef}
          title="Toggle right sidebar"
          aria-label="Toggle right sidebar"
          aria-controls="right-sidebar"
          aria-expanded={rightSidebarOpen}
          className="text-muted-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground"
          onClick={onToggleRightSidebar}
        >
          <PanelRight />
        </Button>
        <SettingsDialog open={settingsOpen} onOpenChange={onSettingsOpenChange} onChangeEditorView={onChangeView} onResetPreferences={onResetPreferences}
          onPrepareAttachmentOperation={onPrepareAttachmentOperation} onReloadWorkspace={onReloadWorkspace} />
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        {windowActions.map(([action, label, Icon]) => (
          <Button
            key={action}
            variant="ghost"
            size="icon-sm"
            title={label}
            aria-label={label}
            className={cn(
              'text-muted-foreground',
              action === 'close' && 'hover:bg-destructive hover:text-destructive-foreground',
            )}
            onClick={() => void runWindowAction(action)}
          >
            <Icon />
          </Button>
        ))}
      </div>
    </header>
  );
}
