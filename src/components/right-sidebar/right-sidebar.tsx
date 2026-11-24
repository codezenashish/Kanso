import { useMemo } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { readNoteMarkdown } from '@/lib/note-markdown';
import { cn } from '@/lib/utils';
import type { NoteProperty, WorkspaceNode } from '@/lib/workspace-tree';
import { NoteLinks } from './note-links';
import { NoteOutline } from './note-outline';
import { NoteProperties } from './note-properties';

const sidebarTabs = [
  ['outline', 'Outline'],
  ['properties', 'Properties'],
  ['links', 'Links'],
] as const;

type RightSidebarProps = {
  open: boolean;
  note: WorkspaceNode | undefined;
  tree: WorkspaceNode[];
  onNavigateHeading: (offset: number) => void;
  onChangeProperties: (properties: NoteProperty[]) => void;
  onOpenNote: (id: string) => void;
};

const panelClass = 'min-h-0 overflow-y-auto overflow-x-hidden px-3 pt-2 pb-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring';

export function RightSidebar({ open, note, tree, onNavigateHeading, onChangeProperties, onOpenNote }: RightSidebarProps) {
  const content = note?.content ?? '';
  const isMarkdown = note?.kind === 'file' && !/\.ya?ml$/i.test(note.name);
  const { headings, links } = useMemo(() => readNoteMarkdown(isMarkdown ? content : ''), [content, isMarkdown]);

  return (
    <aside
      id="right-sidebar"
      aria-label="Note sidebar"
      inert={!open}
      className={cn(
        'shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground transition-[width] motion-reduce:transition-none [--right-sidebar-width:min(--spacing(64),49cqw)]',
        open ? 'w-(--right-sidebar-width)' : 'w-0',
      )}
    >
      <Tabs.Root defaultValue="outline" className="flex h-full w-(--right-sidebar-width) flex-col">
        <Tabs.List activateOnFocus aria-label="Note details" className="flex shrink-0 flex-wrap gap-x-1 px-2 pt-2">
          {sidebarTabs.map(([value, label]) => (
            <Tabs.Tab
              key={value}
              value={value}
              className="min-h-8 flex-1 cursor-pointer rounded-t-sm border-b-2 border-transparent px-1.5 text-xs font-medium text-muted-foreground hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring data-active:border-sidebar-primary data-active:text-sidebar-foreground"
            >
              {label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {note ? (
          <>
            <Tabs.Panel value="outline" className={panelClass}>
              <NoteOutline key={note.id} headings={headings} onNavigate={onNavigateHeading} />
            </Tabs.Panel>
            <Tabs.Panel value="properties" className={panelClass}>
              <NoteProperties key={note.id} properties={note.properties ?? []} onChange={onChangeProperties} />
            </Tabs.Panel>
            <Tabs.Panel value="links" className={panelClass}>
              <NoteLinks key={note.id} links={links} tree={tree} noteId={note.id} onOpenNote={onOpenNote} />
            </Tabs.Panel>
          </>
        ) : sidebarTabs.map(([value]) => (
          <Tabs.Panel key={value} value={value} className={panelClass}>
            <p className="text-sm text-muted-foreground">Open a note to see its details.</p>
          </Tabs.Panel>
        ))}
      </Tabs.Root>
    </aside>
  );
}
