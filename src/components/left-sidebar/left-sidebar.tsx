import { useEffect, useEffectEvent, useRef, useState, type MouseEvent } from 'react';
import { Archive, FilePlus2, FileText, FolderPlus, House, PanelLeftClose, Search, Star, Trash2 } from 'lucide-react';
import type { useWorkspace } from '@/hooks/use-workspace';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { listWorkspaceNotes, listWorkspaceStatus } from '@/lib/workspace-tree';
import { cn } from '@/lib/utils';
import { FileTree } from './file-tree';

type LeftSidebarProps = {
  workspace: ReturnType<typeof useWorkspace>;
  mobileOpen: boolean;
  collapsed: boolean;
  onCollapse: () => void;
  onReveal: () => void;
};

const sections = [
  ['home', 'Home', House],
  ['notes', 'Notes', FileText],
  ['starred', 'Starred', Star],
  ['templates', 'Templates', FileText],
  ['archive', 'Archive', Archive],
  ['trash', 'Trash', Trash2],
] as const;

type SidebarSection = (typeof sections)[number][0];

const emptyMessages: Record<SidebarSection, string> = {
  home: 'Open a note to see it here.',
  notes: 'Create a note to get started.',
  starred: 'Star a note from its actions menu.',
  templates: 'Mark a note as a template from its actions menu.',
  archive: 'Archived notes and folders appear here.',
  trash: 'Notes and folders moved to Trash appear here.',
};

export function LeftSidebar({ workspace, mobileOpen, collapsed, onCollapse, onReveal }: LeftSidebarProps) {
  const [width, setWidth] = useState(272);
  const [section, setSection] = useState<SidebarSection>('notes');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);

  const focusSearch = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
    event.preventDefault();
    onReveal();
    requestAnimationFrame(() => searchRef.current?.focus());
  });

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => focusSearch(event);
    window.addEventListener('keydown', handleShortcut);
    return () => {
      window.removeEventListener('keydown', handleShortcut);
      resizeCleanup.current?.();
    };
  }, []);

  function startResize(event: MouseEvent) {
    event.preventDefault();
    resizeCleanup.current?.();
    const startX = event.clientX;
    const resize = (event: globalThis.MouseEvent) => {
      setWidth(Math.max(220, Math.min(420, width + event.clientX - startX)));
    };
    const stop = () => {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stop);
      resizeCleanup.current = null;
    };
    resizeCleanup.current = stop;
    window.addEventListener('mousemove', resize);
    window.addEventListener('mouseup', stop);
  }

  const browsingNotes = section === 'notes' || Boolean(workspace.draft);
  const searching = Boolean(query.trim()) && !workspace.draft;
  const notes = listWorkspaceNotes(workspace.tree);
  const sectionNodes = {
    home: notes.filter((note) => note.lastOpenedAt || note.id === workspace.activeNode?.id).sort((first, second) => (second.lastOpenedAt ?? 0) - (first.lastOpenedAt ?? 0)),
    notes: workspace.tree,
    starred: notes.filter((note) => note.starred),
    templates: notes.filter((note) => note.template),
    archive: listWorkspaceStatus(workspace.allNodes, 'archived'),
    trash: listWorkspaceStatus(workspace.allNodes, 'trashed'),
  };
  const currentSection = browsingNotes ? 'notes' : section;
  const visibleNodes = searching ? workspace.tree : sectionNodes[currentSection];
  const listTitle = searching ? 'Search results' : currentSection === 'notes' ? 'Workspaces'
    : currentSection === 'home' ? 'Recent notes' : sections.find(([key]) => key === currentSection)?.[1];

  function beginWorkspaceItem(kind: 'file' | 'folder') {
    setSection('notes');
    setQuery('');
    workspace.begin(null, kind);
  }

  return (
    <aside
      aria-label="Explorer"
      className={cn(
        'relative z-10 flex shrink-0 flex-col rounded-xl border border-sidebar-border bg-sidebar px-3 pt-4 pb-3 text-sidebar-foreground sm:max-w-[calc(100%_-_--spacing(70))]',
        collapsed && 'sm:hidden',
        'max-sm:fixed max-sm:inset-y-1.5 max-sm:left-1.5 max-sm:w-[min(84vw,310px)]! max-sm:shadow-lg',
        mobileOpen ? 'max-sm:visible' : 'max-sm:invisible',
      )}
      style={{ width }}
    >
      <div className="mb-2 flex h-8 shrink-0 items-center gap-2 px-1 text-sm font-semibold">
        <span className="grid size-6 place-items-center rounded-md bg-sidebar-foreground font-serif text-sidebar italic">k</span>
        Kanso
        <Button variant="ghost" size="icon-sm" className="ml-auto" title="Collapse sidebar" aria-label="Collapse sidebar" onClick={onCollapse}>
          <PanelLeftClose />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <label className="mb-2 flex h-8 items-center gap-2 rounded-md border border-sidebar-border bg-background/40 px-2 text-muted-foreground focus-within:border-sidebar-ring">
          <Search aria-hidden="true" className="size-4 shrink-0" />
          <input
            ref={searchRef}
            aria-label="Search notes"
            placeholder="Search"
            type="search"
            className="min-w-0 flex-1 bg-transparent text-sm text-sidebar-foreground outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                setQuery('');
              }
            }}
          />
          <kbd className="shrink-0 rounded-sm border border-sidebar-border px-1 text-xs">Ctrl K</kbd>
        </label>
        <nav aria-label="Workspace sections" className="space-y-0.5">
          {sections.map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              aria-current={!searching && currentSection === key ? 'page' : undefined}
              className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-sm hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring aria-current:bg-sidebar-accent aria-current:font-medium aria-current:text-sidebar-accent-foreground"
              onClick={() => {
                workspace.cancelDraft();
                setQuery('');
                setSection(key);
              }}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>
        <section aria-label={listTitle} className="mt-3 border-t border-sidebar-border pt-2">
          <div className="flex min-h-8 items-center justify-between gap-1 ps-2 pe-1">
            <h2 className="text-xs font-medium text-muted-foreground">{listTitle}</h2>
            {browsingNotes && !searching && (
              <div className="flex gap-0.5">
                <Button variant="ghost" size="icon-xs" title="New file" aria-label="New file" onClick={() => beginWorkspaceItem('file')}>
                  <FilePlus2 />
                </Button>
                <Button variant="ghost" size="icon-xs" title="New folder" aria-label="New folder" onClick={() => beginWorkspaceItem('folder')}>
                  <FolderPlus />
                </Button>
              </div>
            )}
          </div>
          <FileTree
            key={searching ? 'search' : currentSection}
            workspace={workspace}
            nodes={visibleNodes}
            query={searching ? query : ''}
            browseFolders={browsingNotes || searching}
          />
          {!searching && !visibleNodes.length && !workspace.draft && (
            <p className="px-2 py-2 text-xs text-muted-foreground">{emptyMessages[currentSection]}</p>
          )}
        </section>
      </div>
      <footer className="mt-2 shrink-0 border-t border-sidebar-border px-2 pt-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-sidebar-primary" />
          Local workspace
        </div>
        <p className="mt-0.5 pl-3.5 text-xs text-muted-foreground">Private · on this device</p>
        <ThemeToggle className="mt-2" size="default" />
      </footer>
      <div className="absolute inset-y-0 -right-0.5 w-1 cursor-col-resize hover:bg-sidebar-ring/40 max-sm:hidden" onMouseDown={startResize} />
    </aside>
  );
}
