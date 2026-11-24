import { getCurrentWindow } from '@tauri-apps/api/window';
import { Braces, FileText, Minus, PanelLeftOpen, PanelRight, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FileTabs } from './file-tabs';

export type EditorView = 'source' | 'document';

const windowActions = [
  ['minimize', 'Minimize window', Minus],
  ['toggleMaximize', 'Maximize or restore window', Square],
  ['close', 'Close window', X],
] as const;

type EditorHeaderProps = {
  files: { id: string; name: string }[];
  activeId: string;
  workspaceSaved: boolean;
  view: EditorView;
  rightSidebarOpen: boolean;
  sourceOnly: boolean;
  onSelectFile: (id: string) => void;
  onCloseFile: (id: string) => void;
  onChangeView: (view: EditorView) => void;
  onToggleRightSidebar: () => void;
  onOpenExplorer: () => void;
};

async function runWindowAction(action: (typeof windowActions)[number][0]) {
  try {
    await getCurrentWindow()[action]();
  } catch {
    // Window controls are only available inside Tauri.
  }
}

export function EditorHeader({
  files, activeId, workspaceSaved, view, rightSidebarOpen, sourceOnly, onSelectFile, onCloseFile, onChangeView, onToggleRightSidebar, onOpenExplorer,
}: EditorHeaderProps) {
  const documentMode = view === 'document';
  const modeUnavailableReason = !activeId
    ? 'Open a note to switch editor modes'
    : sourceOnly ? 'YAML files use Source mode' : undefined;

  return (
    <header className="relative z-10 flex h-13 shrink-0 items-center gap-2 border-b border-border bg-background px-2 sm:px-4">
      <Button variant="ghost" size="icon-sm" className="sm:hidden" aria-label="Show explorer" onClick={onOpenExplorer}>
        <PanelLeftOpen />
      </Button>
      <FileTabs files={files} activeId={activeId} onSelect={onSelectFile} onClose={onCloseFile} />
      <span className="hidden shrink-0 text-xs text-muted-foreground lg:inline">{workspaceSaved ? 'Saved locally' : 'Workspace notice'}</span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Document mode"
          aria-pressed={documentMode}
          aria-disabled={Boolean(modeUnavailableReason)}
          aria-controls={activeId ? 'editor-workspace' : undefined}
          title={modeUnavailableReason ?? (documentMode ? 'Document mode · Switch to Source' : 'Source mode · Switch to Document')}
          className="cursor-pointer border-border bg-secondary text-secondary-foreground aria-disabled:cursor-default aria-disabled:opacity-50"
          onClick={() => {
            if (!modeUnavailableReason) onChangeView(documentMode ? 'source' : 'document');
          }}
        >
          {documentMode ? <FileText aria-hidden="true" /> : <Braces aria-hidden="true" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Toggle right sidebar"
          aria-label="Toggle right sidebar"
          aria-controls="right-sidebar"
          aria-expanded={rightSidebarOpen}
          className="text-muted-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground"
          onClick={onToggleRightSidebar}
        >
          <PanelRight />
        </Button>
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        {windowActions.map(([action, label, Icon]) => (
          <Button
            key={action}
            variant="ghost"
            size="icon-sm"
            title={label}
            aria-label={label}
            className={cn('text-muted-foreground', action === 'close' && 'hover:bg-destructive hover:text-destructive-foreground')}
            onClick={() => void runWindowAction(action)}
          >
            <Icon />
          </Button>
        ))}
      </div>
    </header>
  );
}
