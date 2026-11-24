import { useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ExternalLink, Link } from 'lucide-react';
import type { readNoteMarkdown } from '@/lib/note-markdown';
import type { WorkspaceNode } from '@/lib/workspace-tree';

type NoteLinksProps = {
  links: ReturnType<typeof readNoteMarkdown>['links'];
  tree: WorkspaceNode[];
  noteId: string;
  onOpenNote: (id: string) => void;
};

function listNotePaths(nodes: WorkspaceNode[], parentPath = ''): { id: string; path: string }[] {
  return nodes.flatMap((node) => {
    const path = `${parentPath}/${encodeURIComponent(node.name)}`;
    return node.kind === 'file' ? [{ id: node.id, path }] : listNotePaths(node.children ?? [], path);
  });
}

function resolveLink(target: string, source: string) {
  try {
    return new URL(target, source);
  } catch {
    return undefined;
  }
}

const linkClass = 'flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-start hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring';

export function NoteLinks({ links, tree, noteId, onOpenNote }: NoteLinksProps) {
  const [failedTarget, setFailedTarget] = useState<string>();
  if (!links.length) return <p className="text-sm text-muted-foreground">No links in this note.</p>;

  const notes = listNotePaths(tree);
  const workspaceOrigin = 'https://workspace.invalid';
  const sourcePath = notes.find((note) => note.id === noteId)?.path ?? '/';

  return (
    <ul className="space-y-0.5 text-sm">
      {links.map(({ label, target }) => {
        const destination = resolveLink(target, workspaceOrigin + sourcePath);
        const isExternal = destination && destination.origin !== workspaceOrigin
          && (destination.protocol === 'https:' || destination.protocol === 'http:' || destination.protocol === 'mailto:');
        const linkedNote = destination?.origin === workspaceOrigin && !target.startsWith('#')
          ? notes.find((note) => note.path === destination.pathname || note.path === destination.pathname + '.md')
          : undefined;

        return (
          <li key={target}>
            {isExternal ? (
              <a
                href={destination.href}
                target="_blank"
                rel="noreferrer"
                title={target}
                className={linkClass}
                onClick={(event) => {
                  if (!isTauri()) return;
                  event.preventDefault();
                  setFailedTarget(undefined);
                  void openUrl(destination.href).catch(() => setFailedTarget(target));
                }}
              >
                <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
                <span className="min-w-0 wrap-anywhere">{label}</span>
              </a>
            ) : linkedNote ? (
              <button type="button" className={linkClass} title={target} onClick={() => onOpenNote(linkedNote.id)}>
                <Link aria-hidden="true" className="size-3 shrink-0" />
                <span className="min-w-0 wrap-anywhere">{label}</span>
              </button>
            ) : (
              <span className="block wrap-anywhere px-1.5 py-1 text-muted-foreground" title={target}>{label}</span>
            )}
            {failedTarget === target && <p role="status" className="px-1.5 text-xs text-destructive">Could not open this link.</p>}
          </li>
        );
      })}
    </ul>
  );
}
