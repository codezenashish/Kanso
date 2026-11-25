import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Archive, Copy, RotateCcw, Star, Trash2,
} from 'lucide-react';
import type { useWorkspace } from '@/hooks/use-workspace';
import { searchWorkspaceTree, type WorkspaceNode } from '@/lib/workspace-tree';
import { cn } from '@/lib/utils';

type FileTreeProps = {
  workspace: ReturnType<typeof useWorkspace>;
  query: string;
  nodes: WorkspaceNode[];
  browseFolders: boolean;
};

const rowClass = 'my-px flex h-8 items-center gap-2 rounded-md pr-1 text-sm';
const iconClass = 'size-4 shrink-0';
const inputClass =
  'h-7 min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-foreground outline-none focus:border-ring';
const menuItemClass =
  'flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left hover:bg-accent focus-visible:bg-accent';

export function FileTree({ workspace, query, nodes, browseFolders }: FileTreeProps) {
  const [menu, setMenu] = useState<{ node: WorkspaceNode; x: number; y: number } | null>(null);
  const search = query.trim().toLowerCase();
  const visibleNodes = search ? searchWorkspaceTree(nodes, search) : nodes;

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  function renderDraft(parent: string | null, depth: number) {
    if (workspace.draft?.parent !== parent) return null;
    const Icon = workspace.draft.kind === 'folder' ? Folder : FileText;
    return (
      <div className={rowClass} style={{ paddingInlineStart: `calc(var(--spacing) * ${1 + depth * 4})` }}>
        <span className={iconClass} />
        <Icon className={iconClass} />
        <input
          autoFocus
          aria-label={workspace.draft.kind === 'folder' ? 'New folder name' : 'New note name'}
          className={inputClass}
          value={workspace.draftName}
          onChange={(event) => workspace.setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') workspace.commit();
            if (event.key === 'Escape') workspace.cancelDraft();
          }}
          onBlur={workspace.commit}
        />
      </div>
    );
  }

  function renderNodes(nodes: WorkspaceNode[], depth = 0) {
    return nodes.map((node) => {
      const folder = node.kind === 'folder';
      const open = browseFolders && (workspace.expanded.includes(node.id) || Boolean(search));
      const editing = workspace.renaming === node.id;
      const selected = workspace.activeNode?.id === node.id;
      const Icon = folder ? (open ? FolderOpen : Folder) : FileText;
      const Chevron = open ? ChevronDown : ChevronRight;

      return (
        <div key={node.id}>
          <div
            className={cn(
              rowClass,
              'group relative text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              'data-[drop-target]:bg-sidebar-accent data-[drop-target]:outline-dashed data-[drop-target]:outline-sidebar-ring',
              selected &&
                'bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary',
            )}
            style={{ paddingInlineStart: `calc(var(--spacing) * ${1 + depth * 4})` }}
            draggable={browseFolders && !editing}
            onDragStart={(event) => event.dataTransfer.setData('node', node.id)}
            onDragOver={(event) => {
              if (!folder || !browseFolders) return;
              event.preventDefault();
              event.currentTarget.dataset.dropTarget = '';
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node)) {
                delete event.currentTarget.dataset.dropTarget;
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              delete event.currentTarget.dataset.dropTarget;
              if (browseFolders) workspace.move(event.dataTransfer.getData('node'), folder ? node.id : null);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ node, x: event.clientX, y: event.clientY });
            }}
          >
            {editing ? (
              <>
                {folder ? <Chevron className={iconClass} /> : <span className={iconClass} />}
                <Icon className={iconClass} />
                <input
                  autoFocus
                  aria-label="Rename"
                  defaultValue={node.name}
                  className={inputClass}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') workspace.rename(node.id, event.currentTarget.value);
                    if (event.key === 'Escape') workspace.setRenaming(null);
                  }}
                  onBlur={(event) => workspace.rename(node.id, event.currentTarget.value)}
                />
              </>
            ) : (
              <button
                type="button"
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-left"
                aria-expanded={folder && browseFolders ? open : undefined}
                aria-current={selected ? true : undefined}
                disabled={Boolean(node.status)}
                onClick={() => {
                  if (!folder) {
                    workspace.openFile(node.id);
                    return;
                  }
                  workspace.setExpanded((ids) =>
                    open ? ids.filter((id) => id !== node.id) : [...ids, node.id],
                  );
                }}
              >
                {folder ? <Chevron className={iconClass} /> : <span className={iconClass} />}
                <Icon className={iconClass} />
                <span className="truncate text-sidebar-foreground">{node.name}</span>
                {node.starred && <Star aria-label="Starred" className="size-3 shrink-0 fill-current" />}
              </button>
            )}
            <button
              type="button"
              aria-label={`Actions for ${node.name}`}
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-sm hover:bg-sidebar-border sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ node, x: rect.right, y: rect.bottom });
              }}
            >
              <MoreHorizontal className={iconClass} />
            </button>
          </div>
          {folder && open && (
            <div>
              {renderDraft(node.id, depth + 1)}
              {renderNodes(node.children ?? [], depth + 1)}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <>
      <div
        onDragOver={(event) => {
          if (browseFolders) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!browseFolders) return;
          event.preventDefault();
          workspace.move(event.dataTransfer.getData('node'), null);
        }}
      >
        {browseFolders && renderDraft(null, 0)}
        {renderNodes(visibleNodes)}
        {search && !visibleNodes.length && <p role="status" className="px-2 py-2 text-xs text-muted-foreground">No matching notes.</p>}
      </div>
      {menu && createPortal(
        <div
          aria-label={`Actions for ${menu.node.name}`}
          className="fixed z-20 max-h-dvh w-48 overflow-auto rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
          style={{
            left: Math.max(0, Math.min(menu.x, window.innerWidth - 196)),
            top: Math.max(0, Math.min(menu.y, window.innerHeight - 224)),
          }}
        >
          {menu.node.status ? (
            <>
              <button className={menuItemClass} onClick={() => workspace.changeNodeStatus(menu.node.id, undefined)}>
                <RotateCcw className={iconClass} /> Restore
              </button>
              {menu.node.status === 'trashed' && (
                <button className={cn(menuItemClass, 'text-destructive')} onClick={() => workspace.deletePermanently(menu.node.id)}>
                  <Trash2 className={iconClass} /> Delete permanently
                </button>
              )}
            </>
          ) : (
            <>
              {menu.node.kind === 'folder' ? (
                <>
                  <button className={menuItemClass} onClick={() => workspace.begin(menu.node.id, 'file')}>
                    <FilePlus2 className={iconClass} /> New note inside
                  </button>
                  <button className={menuItemClass} onClick={() => workspace.begin(menu.node.id, 'folder')}>
                    <FolderPlus className={iconClass} /> New folder inside
                  </button>
                </>
              ) : (
                <>
                  <button className={menuItemClass} onClick={() => workspace.toggleNoteFlag(menu.node.id, 'starred')}>
                    <Star className={iconClass} /> {menu.node.starred ? 'Unstar' : 'Star'}
                  </button>
                  <button className={menuItemClass} onClick={() => workspace.toggleNoteFlag(menu.node.id, 'template')}>
                    <FileText className={iconClass} /> {menu.node.template ? 'Remove from Templates' : 'Mark as template'}
                  </button>
                  {menu.node.template && (
                    <button className={menuItemClass} onClick={() => workspace.createFromTemplate(menu.node.id)}>
                      <Copy className={iconClass} /> Use template
                    </button>
                  )}
                </>
              )}
              <button className={menuItemClass} onClick={() => workspace.setRenaming(menu.node.id)}>
                Rename
              </button>
              <button className={menuItemClass} onClick={() => workspace.changeNodeStatus(menu.node.id, 'archived')}>
                <Archive className={iconClass} /> Archive
              </button>
              <button className={cn(menuItemClass, 'text-destructive')} onClick={() => workspace.changeNodeStatus(menu.node.id, 'trashed')}>
                <Trash2 className={iconClass} /> Move to Trash
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
