import { useMemo, useState, type ReactNode } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ChevronRight, ExternalLink, FileCode, FileText, FileType, Link2Off, Plus, type LucideIcon } from 'lucide-react';
import type { NoteLink } from '@/lib/note-markdown';
import type { WikiIndex } from '@/lib/wiki-index';
import { getNoteFormat, type WorkspaceNode } from '@/lib/workspace-tree';
import { Button } from '@/components/ui/button';
import WarmTooltip from '@/components/ui/warm-tooltip';
import { cn } from '@/lib/utils';
import { groupNoteLinks, notePreviewText, type LinkedNote } from './link-sections';

type NoteLinksProps = {
  links: NoteLink[];
  index: WikiIndex;
  noteId: string;
  onOpenNote: (id: string, offset?: number) => void;
  onFollow: (target: string) => void;
  canCreate: (target: string) => boolean;
  getNote: (id: string) => WorkspaceNode | undefined;
};

const focusClass = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring';
const rowClass = cn(
  'flex w-full min-w-0 items-start gap-1.5 rounded-sm px-1.5 py-1.5 text-start hover:bg-sidebar-accent active:bg-sidebar-border aria-current:bg-sidebar-accent aria-current:text-sidebar-accent-foreground',
  focusClass,
);

function LinkSection({ title, count, empty, children }: { title: string; count: number; empty: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-sidebar-border/70 pb-1 last:border-b-0">
      <Collapsible.Root defaultOpen>
        <h3>
          <Collapsible.Trigger className={cn('group flex min-h-8 w-full cursor-pointer items-center gap-1 rounded-sm px-1 text-start text-xs font-medium hover:bg-sidebar-accent', focusClass)}>
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 motion-safe:transition-transform group-aria-expanded:rotate-90" />
            <span className="min-w-0 flex-1">{title}</span>
            <span className="px-1 text-muted-foreground tabular-nums">{count}</span>
          </Collapsible.Trigger>
        </h3>
        <Collapsible.Panel>
          {count ? <ul className="space-y-0.5">{children}</ul> : <p className="px-2 pt-0.5 pb-1 text-xs text-muted-foreground">{empty}</p>}
        </Collapsible.Panel>
      </Collapsible.Root>
    </section>
  );
}

function LinkLabel({ icon: Icon, name, detail, count }: { icon: LucideIcon; name: string; detail?: string; count: number }) {
  return (
    <>
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block wrap-anywhere text-xs leading-4 font-medium">{name}</span>
        {detail && detail !== name && <span className="block truncate text-[0.6875rem] leading-4 text-muted-foreground">{detail}</span>}
      </span>
      {count > 1 && <span className="shrink-0 rounded-sm bg-sidebar-accent px-1 text-[0.6875rem] leading-4 text-sidebar-accent-foreground tabular-nums">
        <span aria-hidden="true">{count}</span><span className="sr-only">{count} references</span>
      </span>}
    </>
  );
}

function LinkedNotePreview({ entry, getNote, markdown }: {
  entry: LinkedNote;
  getNote: NoteLinksProps['getNote'];
  markdown: boolean;
}) {
  const { note, references } = entry;
  const first = references?.[0];
  const preview = (first ? notePreviewText(first.context, true) : '')
    || notePreviewText(getNote(note.id)?.content ?? '', markdown);

  return (
    <span className="block w-52 max-w-[calc(100dvw-2.5rem)] text-xs">
      <span className="block wrap-anywhere font-semibold">{note.name}</span>
      <span className="block wrap-anywhere text-muted-foreground">{note.path}</span>
      {preview && <span className="mt-1 block wrap-anywhere leading-relaxed">{preview}</span>}
    </span>
  );
}

function LinkedNoteRow({ entry, current, onOpenNote, getNote }: Pick<NoteLinksProps, 'onOpenNote' | 'getNote'> & {
  entry: LinkedNote;
  current: boolean;
}) {
  const { note, count, references } = entry;
  const first = references?.[0];
  const hasMultipleReferences = Boolean(references && references.length > 1);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const format = getNoteFormat(note.path);
  const yaml = format === 'yaml';
  const markdown = format === 'markdown';

  return (
    <li>
      <Collapsible.Root open={referencesOpen} onOpenChange={setReferencesOpen}>
        <div className="flex items-start gap-0.5">
          <WarmTooltip
            content={<LinkedNotePreview entry={entry} getNote={getNote} markdown={markdown} />}
            side="left"
            delay={350}
            className="min-w-0 flex-1"
          >
            <button
              type="button"
              aria-current={current ? 'page' : undefined}
              className={cn(rowClass, 'flex-1 cursor-pointer')}
              onClick={() => onOpenNote(note.id, first?.offset)}
            >
              <LinkLabel icon={yaml ? FileCode : markdown ? FileText : FileType} name={note.name} detail={note.path} count={hasMultipleReferences ? 1 : count} />
            </button>
          </WarmTooltip>
          {hasMultipleReferences && (
            <Collapsible.Trigger
              aria-label={`${count} references in ${note.name}`}
              className={cn('mt-1 flex min-h-6 cursor-pointer items-center gap-0.5 rounded-sm px-1 text-xs text-muted-foreground tabular-nums hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent', focusClass)}
            >
              {count}<ChevronRight aria-hidden="true" className={cn('size-3', referencesOpen && 'rotate-90')} />
            </Collapsible.Trigger>
          )}
        </div>
        {hasMultipleReferences && (
          <Collapsible.Panel className="ml-3 space-y-0.5 border-s border-sidebar-border ps-1">
            {referencesOpen && references?.map(({ offset, context }, index) => (
              <button key={offset} type="button" className={cn(rowClass, 'cursor-pointer text-xs text-muted-foreground')}
                aria-label={`Jump to reference ${index + 1} in ${note.name}`}
                onClick={() => onOpenNote(note.id, offset)}>
                <span className="truncate">{notePreviewText(context, true) || `Reference ${index + 1}`}</span>
              </button>
            ))}
          </Collapsible.Panel>
        )}
      </Collapsible.Root>
    </li>
  );
}

export function NoteLinks({ links, index, noteId, onOpenNote, onFollow, canCreate, getNote }: NoteLinksProps) {
  const groups = useMemo(() => groupNoteLinks(index, noteId, links), [index, noteId, links]);
  const [failedTarget, setFailedTarget] = useState<string>();
  const renderNote = (entry: LinkedNote) => (
    <LinkedNoteRow key={entry.note.id} entry={entry} current={entry.note.id === noteId} onOpenNote={onOpenNote} getNote={getNote} />
  );

  return (
    <div className="space-y-1">
      <LinkSection title="Outgoing Links" count={groups.outgoing.length} empty="No linked notes.">
        {groups.outgoing.map(renderNote)}
      </LinkSection>
      <LinkSection title="Backlinks" count={groups.backlinks.length} empty="No notes link here.">
        {groups.backlinks.map(renderNote)}
      </LinkSection>
      <LinkSection title="External Links" count={groups.external.length} empty="No external links.">
        {groups.external.map(({ href, host, label, count }) => (
          <li key={href}>
            <a href={href} target="_blank" rel="noreferrer" title={href} className={rowClass} onClick={(event) => {
              if (!isTauri()) return;
              event.preventDefault();
              setFailedTarget(undefined);
              void openUrl(href).catch(() => setFailedTarget(href));
            }}>
              <LinkLabel icon={ExternalLink} name={label} detail={host} count={count} />
            </a>
            {failedTarget === href && <p role="status" className="px-1.5 text-xs text-destructive">Could not open this link.</p>}
          </li>
        ))}
      </LinkSection>
      <LinkSection title="Unresolved Links" count={groups.unresolved.length} empty="No unresolved links.">
        {groups.unresolved.map(({ target, name, detail, count, wiki }) => (
          <li key={`${wiki}:${target}`} className="flex min-w-0 items-center gap-1 rounded-sm px-1.5 py-1.5 hover:bg-sidebar-accent">
            <LinkLabel icon={Link2Off} name={name} detail={detail} count={count} />
            {wiki && canCreate(target) && (
              <Button type="button" variant="ghost" size="icon-xs" className={cn('shrink-0 cursor-pointer', focusClass)}
                aria-label={`Create note ${name}`} title={`Create note ${name}`} onClick={() => onFollow(target)}>
                <Plus aria-hidden="true" />
              </Button>
            )}
          </li>
        ))}
      </LinkSection>
    </div>
  );
}
