import { lazy, Suspense, useMemo, useRef } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { PanelRightClose } from 'lucide-react';
import { NoteHistoryButton, type NoteHistoryProps } from '@/components/history/note-history';
import { Button } from '@/components/ui/button';
import WarmTooltip, { WarmTooltipGroup } from '@/components/ui/warm-tooltip';
import { readYamlProperties } from '@/lib/note-frontmatter';
import { readNoteMarkdown } from '@/lib/note-markdown';
import { cn } from '@/lib/utils';
import { isSourceOnlyNote, type NoteProperty, type WorkspaceNode } from '@/lib/workspace-tree';
import type { WikiIndex } from '@/lib/wiki-index';
import { NoteLinks } from './note-links';
import { NoteOutline } from './note-outline';
import { NoteProperties } from './note-properties';
import { sidebarPanels, useSidebarPreferences } from './sidebar-preferences';
import { SidebarResize, useSidebarWidth } from './sidebar-resize';

const GraphPanel = lazy(() => import('@/components/knowledge-graph/graph-panel'));

type RightSidebarProps = {
  open: boolean;
  graphOpen: boolean;
  onGraphOpenChange: (open: boolean) => void;
  onCollapse: () => void;
  onRestoreVersion: NoteHistoryProps['onRestore'];
  note: WorkspaceNode | undefined;
  getNote: (id: string) => WorkspaceNode | undefined;
  onNavigateHeading: (offset: number) => void;
  onChangeProperties: (properties: NoteProperty[]) => void;
  tagNames: string[];
  onChangeTags: (tags: string[]) => boolean;
  onOpenNote: (id: string, offset?: number) => void;
  wiki: WikiIndex;
  noteTags: ReadonlyMap<string, readonly string[]>;
  onFollowWikiLink: (target: string) => void;
  canCreateWikiNote: (target: string) => boolean;
};

const panelClass = 'min-w-0 min-h-0 overflow-y-auto overflow-x-hidden bg-sidebar bg-local px-3 pt-1 pb-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring';

export function RightSidebar({ open, graphOpen, onGraphOpenChange, onCollapse, onRestoreVersion, note, getNote, onNavigateHeading, onChangeProperties, tagNames, onChangeTags, onOpenNote, wiki, noteTags, onFollowWikiLink, canCreateWikiNote }: RightSidebarProps) {
  const aside = useRef<HTMLElement>(null);
  const { preferences, setPanel, setWidth } = useSidebarPreferences();
  const { panel: tab } = preferences;
  const title = sidebarPanels.find(({ id }) => id === tab)?.title;
  const bounds = useSidebarWidth(aside, preferences.width);
  const content = note?.content ?? '';
  const isMarkdown = note?.kind === 'file' && !isSourceOnlyNote(note.name);
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
          <WarmTooltipGroup delay={350}>
            <Tabs.List activateOnFocus aria-label="Note details" className="flex min-w-0 flex-wrap gap-0.5">
              {sidebarPanels.map(({ id, title, Icon }) => (
                <WarmTooltip key={id} content={title} side="bottom" gap={6}>
                  <Tabs.Tab
                    value={id}
                    aria-label={title}
                    className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sidebar-ring data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground"
                  >
                    <Icon aria-hidden="true" className="size-3.5" />
                  </Tabs.Tab>
                </WarmTooltip>
              ))}
            </Tabs.List>
          </WarmTooltipGroup>
          {open && note && <NoteHistoryButton key={note.id} note={note} onRestore={onRestoreVersion} />}
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground"
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
              <NoteProperties key={note.id} note={note} frontmatter={yamlProperties} onChange={onChangeProperties}
                tagNames={tagNames} onChangeTags={onChangeTags} />
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
              <GraphPanel expanded={graphOpen} setExpanded={onGraphOpenChange} index={wiki} activeId={note?.id ?? ''} noteTags={noteTags} onOpenNote={onOpenNote} />
            </Suspense>
          )}
        </Tabs.Panel>
      </Tabs.Root>
    </aside>
  );
}
