import { lazy, Suspense, useMemo, useRef } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { Tooltip } from '@base-ui/react/tooltip';
import { PanelRightClose } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { readYamlProperties } from '@/lib/note-frontmatter';
import { readNoteMarkdown } from '@/lib/note-markdown';
import { cn } from '@/lib/utils';
import type { NoteProperty, WorkspaceNode } from '@/lib/workspace-tree';
import type { WikiIndex } from '@/lib/wiki-index';
import { NoteLinks } from './note-links';
import { NoteOutline } from './note-outline';
import { NoteProperties } from './note-properties';
import { sidebarPanels, useSidebarPreferences } from './sidebar-preferences';
import { SidebarResize, useSidebarWidth } from './sidebar-resize';

const GraphPanel = lazy(() => import('@/components/knowledge-graph/graph-panel'));

type RightSidebarProps = {
  open: boolean;
  onCollapse: () => void;
  note: WorkspaceNode | undefined;
  getNote: (id: string) => WorkspaceNode | undefined;
  onNavigateHeading: (offset: number) => void;
  onChangeProperties: (properties: NoteProperty[]) => void;
  onOpenNote: (id: string, offset?: number) => void;
  wiki: WikiIndex;
  onFollowWikiLink: (target: string) => void;
  canCreateWikiNote: (target: string) => boolean;
};

const panelClass = 'min-w-0 min-h-0 overflow-y-auto overflow-x-hidden bg-sidebar bg-local px-3 pt-1 pb-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring';

export function RightSidebar({ open, onCollapse, note, getNote, onNavigateHeading, onChangeProperties, onOpenNote, wiki, onFollowWikiLink, canCreateWikiNote }: RightSidebarProps) {
  const aside = useRef<HTMLElement>(null);
  const { preferences, setPanel, setWidth } = useSidebarPreferences();
  const { panel: tab } = preferences;
  const title = sidebarPanels.find(({ id }) => id === tab)?.title;
  const bounds = useSidebarWidth(aside, preferences.width);
  const content = note?.content ?? '';
  const isMarkdown = note?.kind === 'file' && !/\.(?:txt|ya?ml)$/i.test(note.name);
  const { headings, links, frontmatter } = useMemo(() => readNoteMarkdown(isMarkdown ? content : ''), [content, isMarkdown]);

  const yamlProperties = useMemo(() => frontmatter === null ? null : readYamlProperties(frontmatter), [frontmatter]);

  return (
    <aside
      ref={aside}
      id="right-sidebar"
      aria-label="Note sidebar"
      inert={!open}
      className="relative shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground"
      style={{ width: open ? bounds.width : 0 }}
    >
      {open && <SidebarResize {...bounds} onResize={setWidth} />}
      <Tabs.Root id="note-sidebar-content" value={tab} onValueChange={setPanel} className="flex h-full min-w-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-0.5 px-2 pt-2">
          <Tooltip.Provider delay={350}>
            <Tabs.List activateOnFocus aria-label="Note details" className="flex min-w-0 flex-wrap gap-0.5">
              {sidebarPanels.map(({ id, title, Icon }) => (
                <Tooltip.Root key={id}>
                  <Tooltip.Trigger
                    render={<Tabs.Tab value={id} />}
                    aria-label={title}
                    className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sidebar-ring data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground"
                  >
                    <Icon aria-hidden="true" className="size-3.5" />
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Positioner side="bottom" sideOffset={6} className="z-40">
                      <Tooltip.Popup role="tooltip" className="rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm">{title}</Tooltip.Popup>
                    </Tooltip.Positioner>
                  </Tooltip.Portal>
                </Tooltip.Root>
              ))}
            </Tabs.List>
          </Tooltip.Provider>
          <Button variant="ghost" size="icon-xs" className="ms-auto text-muted-foreground"
            title="Collapse note sidebar" aria-label="Collapse note sidebar" onClick={onCollapse}>
            <PanelRightClose aria-hidden="true" />
          </Button>
        </div>
        <h2 className="subheading shrink-0 truncate px-3 pt-2 pb-1">{title}</h2>
        {note ? (
          <>
            <Tabs.Panel value="outline" className={panelClass}>
              <NoteOutline key={note.id} headings={headings} onNavigate={onNavigateHeading} />
            </Tabs.Panel>
            <Tabs.Panel value="properties" className={panelClass}>
              <NoteProperties key={note.id} properties={note.properties ?? []} frontmatter={yamlProperties} onChange={onChangeProperties} />
            </Tabs.Panel>
            <Tabs.Panel value="links" className={panelClass}>
              <NoteLinks links={links} index={wiki} noteId={note.id} getNote={getNote} onOpenNote={onOpenNote}
                onFollow={onFollowWikiLink} canCreate={canCreateWikiNote} />
            </Tabs.Panel>
          </>
        ) : sidebarPanels.filter(({ id }) => id !== 'graph').map(({ id: value }) => (
          <Tabs.Panel key={value} value={value} className={panelClass}>
            <p className="small-text">Open a note to see its details.</p>
          </Tabs.Panel>
        ))}
        <Tabs.Panel value="graph" className={cn(panelClass, 'flex flex-1 flex-col px-2')}>
          {open && tab === 'graph' && (
            <Suspense fallback={<p role="status" className="px-1 text-xs text-muted-foreground">Loading graph…</p>}>
              <GraphPanel index={wiki} activeId={note?.id ?? ''} onOpenNote={onOpenNote} />
            </Suspense>
          )}
        </Tabs.Panel>
      </Tabs.Root>
    </aside>
  );
}
