import { Menu } from '@base-ui/react/menu';
import { Archive, ChevronRight, Ellipsis } from 'lucide-react';
import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { menuItemClass, menuPopupClass, menuPositionerClass } from '@/components/ui/menu-styles';

export type BreadcrumbFolder = { id: string; name: string; path: string };
export type EditorLocation = {
  folders: BreadcrumbFolder[];
  note: { id: string; name: string };
  archived: boolean;
};

const crumbClass = 'min-w-0 rounded px-1 text-left hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring';
const separatorClass = 'size-3 shrink-0 text-muted-foreground';

export function EditorBreadcrumb({ location, onReveal }: { location: EditorLocation; onReveal: (id: string) => void }) {
  const { folders, note, archived } = location;
  const lastFolders = folders.slice(-2);
  const fullPath = [...folders.map(({ name }) => name), note.name].join(' / ');
  const revealFromMenu = useRef(false);

  return (
    <nav aria-label="Note location" className="@container min-w-0 max-w-[45%] flex-[1_1_15rem]">
      <ol className="flex h-8 min-w-0 items-center gap-0.5 overflow-hidden text-xs">
        {folders.length > 0 && (
          <li className={cn('flex shrink-0 items-center', folders.length <= 2 && '@min-[14rem]:hidden')}>
            <Menu.Root onOpenChange={(open) => { if (open) revealFromMenu.current = false; }}>
              <Menu.Trigger
                className={cn(crumbClass, 'grid size-6 place-items-center text-muted-foreground')}
                aria-label="Show parent folders" title={fullPath}>
                <Ellipsis aria-hidden="true" className="size-4" />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner align="start" sideOffset={4} className={menuPositionerClass}>
                  <Menu.Popup aria-label="Parent folders" finalFocus={() => !revealFromMenu.current}
                    className={cn(menuPopupClass, "w-60")}>
                    {folders.map(({ id, name, path }) => (
                      <Menu.Item key={id} aria-label={`Reveal folder ${path}`} title={path}
                        className={cn(menuItemClass, "cursor-pointer truncate")}
                        onClick={() => {
                          revealFromMenu.current = true;
                          onReveal(id);
                        }}>
                        {name}
                      </Menu.Item>
                    ))}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
            <ChevronRight aria-hidden="true" className={separatorClass} />
          </li>
        )}
        {lastFolders.map(({ id, name, path }) => (
          <li key={id} className="hidden min-w-0 max-w-24 items-center @min-[14rem]:flex">
            <button type="button" className={cn(crumbClass, 'h-6 truncate text-muted-foreground')}
              title={path} aria-label={`Reveal folder ${path}`} onClick={() => onReveal(id)}>
              {name}
            </button>
            <ChevronRight aria-hidden="true" className={separatorClass} />
          </li>
        ))}
        <li className="min-w-0 flex-1">
          <button type="button" aria-current="page" title={fullPath}
            aria-label={`Reveal ${archived ? 'archived note' : 'note'} ${fullPath}`}
            className={cn(crumbClass, 'flex h-6 max-w-full items-center gap-1 font-medium')}
            onClick={() => onReveal(note.id)}>
            {archived && <Archive aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />}
            <span className="truncate">{note.name}</span>
          </button>
        </li>
      </ol>
    </nav>
  );
}
