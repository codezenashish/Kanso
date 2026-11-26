import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type PointerEvent, type Ref } from 'react';
import { Archive, FilePlus2, FileText, FolderPlus, House, PanelLeftClose, Search, Star, Tag, Trash2, Upload } from 'lucide-react';
import type { useWorkspace } from '@/hooks/use-workspace';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { availableTree, find, listWorkspaceNotes, listWorkspaceStatus } from '@/lib/workspace-tree';
import { defaultSearchFilters, type SearchResult } from '@/lib/workspace-search';
import { leftSidebarWidthRange, updateSettings, useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { FileTree } from './file-tree';
import { UseTemplateDialog } from './use-template-dialog';
import { WorkspaceSearchResults } from './workspace-search-results';
import { TagManager } from './tag-manager';
import type { MarkdownTransferRequest } from '@/components/markdown-transfer/markdown-transfer-dialog';
import { readMarkdownDrop } from '@/lib/markdown-transfer';

type LeftSidebarProps = {
  workspace: ReturnType<typeof useWorkspace>;
  mobileOpen: boolean;
  collapsed: boolean;
  onCollapse: () => void;
  searchInputRef: Ref<HTMLInputElement>;
  onMarkdownTransfer: (request: MarkdownTransferRequest) => void;
  onOpenSearchResult: (result: SearchResult) => boolean;
  onCreatedFromTemplate?: () => void;
  revealRequest: { id: string } | null;
};

const sections = [
  ['home', 'Home', House],
  ['notes', 'Notes', FileText],
  ['starred', 'Starred', Star],
  ['templates', 'Templates', FileText],
  ['tags', 'Tags', Tag],
  ['archive', 'Archive', Archive],
  ['trash', 'Trash', Trash2],
] as const;

type SidebarSection = (typeof sections)[number][0];

const emptyMessages: Record<SidebarSection, string> = {
  home: 'Open a note to see it here.',
  notes: 'Create a note to get started.',
  starred: 'Star a note from its actions menu.',
  templates: 'Mark a note as a template from its actions menu.',
  tags: 'No tags yet.',
  archive: 'Archived notes and folders appear here.',
  trash: 'Notes and folders moved to Trash appear here.',
};

export function LeftSidebar({ workspace, mobileOpen, collapsed, onCollapse, searchInputRef, onMarkdownTransfer, onOpenSearchResult, onCreatedFromTemplate, revealRequest }: LeftSidebarProps) {
  const { leftSidebarWidth } = useSettings();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? leftSidebarWidth;
  const { min, max } = leftSidebarWidthRange;
  const sidebarRef = useRef<HTMLElement>(null);
  const [section, setSection] = useState<SidebarSection>('notes');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(defaultSearchFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [revealedNode, setRevealedNode] = useState<{ id: string } | null>(null);
  const [templateRequest, setTemplateRequest] = useState<{ id: string; restoreFocusTarget: HTMLElement | null } | null>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);

  const revealNode = useEffectEvent((request: { id: string }) => {
    const { folders, notes } = workspace.searchIndex;
    const folder = folders.get(request.id);
    const entry = folder ?? notes.get(request.id);
    if (!entry) return;
    clearSearch();
    setSection(entry.archived ? 'archive' : 'notes');
    const ancestors = entry.folders.filter((id) => folders.get(id)?.archived === entry.archived);
    const toExpand = folder ? [...ancestors, request.id] : ancestors;
    workspace.setExpanded((ids) => {
      const missing = toExpand.filter((id) => !ids.includes(id));
      return missing.length ? [...ids, ...missing] : ids;
    });
    setRevealedNode(request);
  });

  useEffect(() => {
    if (revealRequest) revealNode(revealRequest);
  }, [revealRequest]);

  useLayoutEffect(() => {
    if (!revealedNode) return;
    const row = sidebarRef.current?.querySelector<HTMLElement>(`[data-explorer-node="${CSS.escape(revealedNode.id)}"]`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
  }, [revealedNode]);

  useEffect(() => () => resizeCleanup.current?.(), []);

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return;

    event.preventDefault();
    resizeCleanup.current?.();
    event.currentTarget.focus({ preventScroll: true });

    const { clientX: startX, pointerId } = event;
    const startWidth = sidebarRef.current?.offsetWidth ?? width;
    const controller = new AbortController();
    const { signal } = controller;
    const getWidth = (clientX: number) => Math.min(max, Math.max(min, startWidth + clientX - startX));

    function cleanup() {
      controller.abort();
      resizeCleanup.current = null;
    }

    function cancel() {
      cleanup();
      setDragWidth(null);
    }

    resizeCleanup.current = cleanup;
    window.addEventListener('pointermove', (next) => {
      if (next.pointerId !== pointerId) return;
      setDragWidth(next.clientX === startX ? null : getWidth(next.clientX));
    }, { signal });
    window.addEventListener('pointerup', (next) => {
      if (next.pointerId !== pointerId) return;
      if (next.clientX !== startX) updateSettings({ leftSidebarWidth: getWidth(next.clientX) });
      cancel();
    }, { signal });
    window.addEventListener('pointercancel', (next) => {
      if (next.pointerId === pointerId) cancel();
    }, { signal });
    window.addEventListener('blur', cancel, { signal });
  }

  const browsingNotes = section === 'notes' || Boolean(workspace.draft);
  const searching = (Boolean(query.trim()) || filtersOpen) && !workspace.draft;
  const notes = listWorkspaceNotes(workspace.tree);
  const sectionNodes = {
    home: notes.filter((note) => note.lastOpenedAt || note.id === workspace.activeNode?.id).sort((first, second) => (second.lastOpenedAt ?? 0) - (first.lastOpenedAt ?? 0)),
    notes: workspace.tree,
    starred: notes.filter((note) => note.starred),
    templates: notes.filter((note) => note.template),
    tags: [],
    archive: availableTree(listWorkspaceStatus(workspace.allNodes, 'archived'), true),
    trash: listWorkspaceStatus(workspace.allNodes, 'trashed'),
  };
  const currentSection = browsingNotes ? 'notes' : section;
  const visibleNodes = sectionNodes[currentSection];
  const listTitle = searching ? 'Search results' : currentSection === 'notes' ? 'Workspaces'
    : currentSection === 'home' ? 'Recent notes' : sections.find(([key]) => key === currentSection)?.[1];

  function clearSearch() {
    setQuery('');
    setFilters(defaultSearchFilters);
    setFiltersOpen(false);
  }

  function beginWorkspaceItem(kind: 'file' | 'folder') {
    setSection('notes');
    clearSearch();
    workspace.begin(null, kind);
  }

  return (
    <aside
      ref={sidebarRef}
      id="workspace-explorer"
      aria-label="Explorer"
      className={cn(
        'relative z-10 flex shrink-0 flex-col rounded-xl border border-sidebar-border bg-sidebar px-3 pt-4 pb-3 text-sidebar-foreground sm:max-w-[calc(100%_-_--spacing(70))]',
        collapsed && 'sm:hidden',
        'max-sm:fixed max-sm:inset-y-1.5 max-sm:left-1.5 max-sm:w-[min(84vw,310px)]! max-sm:shadow-lg',
        mobileOpen ? 'max-sm:visible' : 'max-sm:invisible',
      )}
      style={{ width }}
      onDragOverCapture={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDropCapture={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        const destination = event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-import-folder]')?.dataset.importFolder ?? null : null;
        const dropped = readMarkdownDrop(event.dataTransfer).catch(() => ({
          entries: [], issues: ['Some dropped items could not be read. Try the file or folder picker.'],
        }));
        onMarkdownTransfer({ mode: 'import', destination, dropped });
      }}
    >
      <div className="mb-2 flex h-8 shrink-0 items-center gap-2 px-1 text-sm font-medium">
        <span className="grid size-6 place-items-center rounded-md bg-sidebar-primary font-serif text-sidebar-primary-foreground italic">k</span>
        Kanso
        <Button variant="ghost" size="icon-sm" className="ml-auto" title="Collapse sidebar" aria-label="Collapse sidebar" onClick={onCollapse}>
          <PanelLeftClose />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-sidebar bg-local">
        <label className="mb-2 flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2 text-muted-foreground focus-within:border-sidebar-ring">
          <Search aria-hidden="true" className="size-4 shrink-0" />
          <input
            ref={searchInputRef}
            aria-label="Search notes"
            placeholder="Search"
            type="search"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && searching) {
                event.preventDefault();
                clearSearch();
              }
            }}
          />
          <kbd className="shrink-0 rounded-sm border border-sidebar-border px-1 text-xs">Ctrl K</kbd>
        </label>
        {!query.trim() && (
          <Button type="button" size="xs" variant="ghost" className="mb-1" aria-expanded={filtersOpen} onClick={() => {
            if (filtersOpen) clearSearch();
            else setFiltersOpen(true);
          }}>Search filters</Button>
        )}
        <nav aria-label="Workspace sections" className="space-y-0.5">
          {sections.map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              aria-current={!searching && currentSection === key ? 'page' : undefined}
              className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-sm hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring aria-current:bg-sidebar-accent aria-current:font-medium aria-current:text-sidebar-accent-foreground"
              onClick={() => {
                workspace.cancelDraft();
                clearSearch();
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
                <Button variant="ghost" size="icon-xs" title="Import Markdown" aria-label="Import Markdown"
                  onClick={() => onMarkdownTransfer({ mode: 'import', destination: null })}>
                  <Upload aria-hidden="true" />
                </Button>
                <Button variant="ghost" size="icon-xs" title="New file" aria-label="New file" onClick={() => beginWorkspaceItem('file')}>
                  <FilePlus2 />
                </Button>
                <Button variant="ghost" size="icon-xs" title="New folder" aria-label="New folder" onClick={() => beginWorkspaceItem('folder')}>
                  <FolderPlus />
                </Button>
              </div>
            )}
          </div>
          {searching ? (
            <WorkspaceSearchResults
              key={query.trim()}
              index={workspace.searchIndex}
              query={query}
              filters={filters}
              onChangeFilters={setFilters}
              onOpen={onOpenSearchResult}
            />
          ) : currentSection === 'tags' ? (
            <TagManager workspace={workspace} />
          ) : (
            <FileTree key={currentSection} workspace={workspace} nodes={visibleNodes} onMarkdownTransfer={onMarkdownTransfer}
              browseFolders={browsingNotes || currentSection === 'archive'} archiveBrowsing={currentSection === 'archive'}
              onUseTemplate={(id, restoreFocusTarget) => setTemplateRequest({ id, restoreFocusTarget })} />
          )}
          {!searching && currentSection !== 'tags' && !visibleNodes.length && !workspace.draft && (
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
      <UseTemplateDialog
        template={templateRequest ? (() => {
          const candidate = find(workspace.tree, templateRequest.id);
          return candidate?.template ? candidate : null;
        })() : null}
        tree={workspace.allNodes}
        flushWorkspace={workspace.flushWorkspace}
        restoreFocusTarget={templateRequest?.restoreFocusTarget ?? null}
        onClose={() => setTemplateRequest(null)}
        onCreate={workspace.createFromTemplate}
        onCreated={() => onCreatedFromTemplate?.()}
      />
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize explorer"
        aria-controls="workspace-explorer"
        aria-orientation="vertical"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={width}
        className="absolute inset-y-0 -right-0.5 w-2 touch-none cursor-col-resize hover:bg-sidebar-ring/40 focus-visible:outline-2 focus-visible:outline-sidebar-ring max-sm:hidden"
        onPointerDown={startResize}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 40 : 10;
          const nextWidth = event.key === 'ArrowRight' ? width + step
            : event.key === 'ArrowLeft' ? width - step
            : event.key === 'Home' ? min
            : event.key === 'End' ? max
            : null;
          if (nextWidth === null) return;
          event.preventDefault();
          updateSettings({ leftSidebarWidth: nextWidth });
        }}
      />
    </aside>
  );
}
