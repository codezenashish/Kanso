import { ContextMenu } from '@base-ui/react/context-menu';
import { FileText, Pin, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { menuItemClass, menuPopupClass, menuPositionerClass } from '@/components/ui/menu-styles';

type FileTab = { id: string; name: string; pinned: boolean };

export type FileTabsProps = {
  files: FileTab[];
  activeId: string;
  actions: {
    select: (id: string) => void;
    close: (id: string) => void;
    closeOthers: (id: string) => void;
    closeToRight: (id: string) => void;
    togglePin: (id: string) => void;
    reorder: (id: string, targetId: string) => void;
    reveal: (id: string) => void;
  };
};

const tabDragType = 'application/x-kanso-editor-tab';

function openTabMenu(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
  event.preventDefault();
  const button = event.currentTarget;
  const bounds = button.getBoundingClientRect();
  button.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: bounds.left, clientY: bounds.bottom,
  }));
}

export function FileTabs({ files, activeId, actions }: FileTabsProps) {
  const tabStrip = useRef<HTMLDivElement>(null);
  const activeButton = useRef<HTMLButtonElement>(null);
  const draggedTab = useRef<string>(null);
  const revealingTab = useRef<string>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const activeIndex = files.findIndex(({ id }) => id === activeId);

  useLayoutEffect(() => {
    const strip = tabStrip.current;
    const tab = activeButton.current?.parentElement;
    if (!strip || !tab) return;
    const stripBounds = strip.getBoundingClientRect();
    const tabBounds = tab.getBoundingClientRect();
    if (tabBounds.left < stripBounds.left) strip.scrollLeft += tabBounds.left - stripBounds.left;
    else if (tabBounds.right > stripBounds.right) strip.scrollLeft += tabBounds.right - stripBounds.right;
  }, [activeId, activeIndex]);

  function clearDrag() {
    draggedTab.current = null;
    setDropTarget(null);
  }

  return (
    <div ref={tabStrip} className="flex h-9 min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="group" aria-label="Open files">
      {files.map((file, index) => (
        <ContextMenu.Root key={file.id}>
          <ContextMenu.Trigger
            draggable={files.length > 1}
            className={cn(
              'flex h-9 max-w-55 shrink-0 items-center gap-1 rounded-md border px-1.5 text-sm',
              activeId === file.id ? 'border-border bg-background text-foreground' : 'border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              dropTarget === file.id && 'border-ring',
            )}
            onDragStart={(event) => {
              draggedTab.current = file.id;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(tabDragType, file.id);
            }}
            onDragOver={(event) => {
              if (!draggedTab.current || draggedTab.current === file.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropTarget(file.id);
            }}
            onDragLeave={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
              setDropTarget((current) => current === file.id ? null : current);
            }}
            onDrop={(event) => {
              const source = draggedTab.current;
              if (!source || event.dataTransfer.getData(tabDragType) !== source) return;
              event.preventDefault();
              actions.reorder(source, file.id);
              clearDrag();
            }}
            onDragEnd={clearDrag}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              actions.close(file.id);
            }}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
          >
            <button
              ref={activeId === file.id ? activeButton : undefined}
              data-file-tab={file.id}
              className="flex h-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              aria-current={activeId === file.id}
              onClick={() => actions.select(file.id)}
              onKeyDown={openTabMenu}
            >
              {file.pinned ? <Pin aria-label="Pinned" className="size-4 shrink-0" /> : <FileText aria-hidden="true" className="size-4 shrink-0" />}
              <span className="truncate">{file.name}</span>
            </button>
            <button
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring hover:bg-sidebar-border"
              aria-label={`Close ${file.name}`}
              title={`Close ${file.name}`}
              onClick={() => actions.close(file.id)}
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Positioner className={menuPositionerClass}>
              <ContextMenu.Popup aria-label={`Tab actions for ${file.name}`} className={cn(menuPopupClass, "w-44")}
                finalFocus={() => {
                  if (revealingTab.current === file.id) {
                    revealingTab.current = null;
                    return false;
                  }
                  return document.querySelector<HTMLElement>(`[data-file-tab="${CSS.escape(file.id)}"]`);
                }}>
                <ContextMenu.Item className={menuItemClass} onClick={() => actions.togglePin(file.id)}>
                  {file.pinned ? 'Unpin tab' : 'Pin tab'}
                </ContextMenu.Item>
                <ContextMenu.Item className={menuItemClass} disabled={index === 0} onClick={() => actions.reorder(file.id, files[index - 1].id)}>Move left</ContextMenu.Item>
                <ContextMenu.Item className={menuItemClass} disabled={index === files.length - 1} onClick={() => actions.reorder(file.id, files[index + 1].id)}>Move right</ContextMenu.Item>
                <ContextMenu.Item className={menuItemClass} onClick={() => {
                  revealingTab.current = file.id;
                  actions.reveal(file.id);
                }}>Reveal in explorer</ContextMenu.Item>
                <ContextMenu.Separator className="my-1 h-px bg-border" />
                <ContextMenu.Item className={menuItemClass} disabled={!files.some((other) => other.id !== file.id && !other.pinned)} onClick={() => actions.closeOthers(file.id)}>Close others</ContextMenu.Item>
                <ContextMenu.Item className={menuItemClass} disabled={!files.slice(index + 1).some((other) => !other.pinned)} onClick={() => actions.closeToRight(file.id)}>Close to right</ContextMenu.Item>
              </ContextMenu.Popup>
            </ContextMenu.Positioner>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      ))}
    </div>
  );
}
