import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Dialog } from '@base-ui/react/dialog';
import { History, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { RestoreVersionResult } from '@/hooks/use-workspace-persistence';
import { getNoteVersion, historyErrorMessage, listNoteVersions, type NoteVersionDetail, type NoteVersionSummary } from '@/lib/database/history-database';
import { cn } from '@/lib/utils';
import type { WorkspaceNode } from '@/lib/workspace-tree';
import { diffLines } from './line-diff';

export type NoteHistoryProps = {
  note: WorkspaceNode;
  onRestore: (noteId: string, versionId: string) => Promise<RestoreVersionResult>;
};

const pageSize = 30;
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const reasons = { autosave: 'Autosave', manual: 'Manual snapshot', restore_checkpoint: 'Before restore' };
const backdrop = 'fixed inset-0 z-30 bg-black/45';
const popup = 'fixed top-1/2 left-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background text-foreground shadow-xl';

function RestoreConfirmation({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger render={<Button disabled={disabled} />}>Restore this version</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={backdrop} />
        <AlertDialog.Popup initialFocus={cancel} className={`${popup} w-[min(25rem,calc(100%-1.5rem))] p-5`}>
          <AlertDialog.Title className="font-semibold">Restore this version?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
            Kanso will save pending edits and keep the current content and properties in history before restoring the selected version.
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close render={<Button ref={cancel} variant="outline" />}>Cancel</AlertDialog.Close>
            <AlertDialog.Close render={<Button onClick={onConfirm} />}>Restore version</AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function VersionPreview({ version, current }: { version: NoteVersionDetail; current: string }) {
  const [mode, setMode] = useState<'preview' | 'changes'>('preview');
  const diff = useMemo(() => mode === 'changes' ? diffLines(current, version.content) : [], [mode, current, version.content]);
  const changes = diff.some((line) => line.kind !== 'same');
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>Preview</Button>
        <Button variant="outline" aria-pressed={mode === 'changes'} onClick={() => setMode('changes')}>Changes</Button>
      </div>
      {mode === 'preview' ? (
        <>
          {!!version.properties?.length && (
            <dl className="mb-3 divide-y divide-border rounded-md border border-border px-3 text-sm">
              {version.properties.map(({ name, value }, index) => (
                <div key={index} className="grid grid-cols-2 gap-2 py-1.5">
                  <dt className="wrap-anywhere font-medium">{name}</dt>
                  <dd className="wrap-anywhere text-muted-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {version.attachmentIds.length > 0 && <p className="mb-2 text-sm text-muted-foreground">Attachments in this version ({version.attachmentIds.length})</p>}
          {version.content
            ? <pre aria-label="Read-only version content" className="wrap-anywhere whitespace-pre-wrap rounded-md border border-border bg-card p-3 font-mono text-sm">{version.content}</pre>
            : <p className="text-sm text-muted-foreground">This version has no note text.</p>}
        </>
      ) : changes ? (
        <>
          <p className="mb-2 text-sm text-muted-foreground">Changes to note text if this version is restored.</p>
          <div aria-label="Changes to note text" className="overflow-hidden rounded-md border border-border font-mono text-sm">
            {diff.map(({ kind, text }, index) => (
              <div key={index} className={cn('flex gap-2 px-2 whitespace-pre-wrap',
                kind === 'added' && 'bg-emerald-700/12 dark:bg-emerald-400/15',
                kind === 'removed' && 'bg-destructive/12 dark:bg-destructive/20')}>
                <span aria-hidden="true" className="w-4 shrink-0">{kind === 'added' ? '+' : kind === 'removed' ? '−' : ' '}</span>
                {kind !== 'same' && <span className="sr-only">{kind === 'added' ? 'Added ' : 'Removed '}</span>}
                <span className="min-w-0 wrap-anywhere">{text || '\u00a0'}</span>
              </div>
            ))}
          </div>
        </>
      ) : <p className="text-sm text-muted-foreground">The note text matches the current version.</p>}
    </>
  );
}

function HistoryContent({ note, onRestore, busy, setBusy }: NoteHistoryProps & {
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const [versions, setVersions] = useState<NoteVersionSummary[]>();
  const [selectedId, setSelectedId] = useState('');
  const [preview, setPreview] = useState<NoteVersionDetail>();
  const [listError, setListError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const [previewReload, setPreviewReload] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const mounted = useRef(false);
  const previewPane = useRef<HTMLDivElement>(null);
  const noteId = note.id;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    void listNoteVersions(noteId, pageSize, 0).then((rows) => {
      if (!current) return;
      setVersions(rows);
      setSelectedId(rows[0]?.id ?? '');
      setHasMore(rows.length === pageSize);
    }, (error) => { if (current) setListError(historyErrorMessage(error)); });
    return () => { current = false; };
  }, [noteId, reload]);

  useEffect(() => {
    if (!selectedId) return;
    let current = true;
    void getNoteVersion(noteId, selectedId).then((version) => {
      if (current) setPreview(version);
    }, (error) => { if (current) setPreviewError(historyErrorMessage(error)); });
    return () => { current = false; };
  }, [noteId, selectedId, previewReload]);

  function select(id: string) {
    if (id === selectedId) return;
    setPreview(undefined);
    setPreviewError('');
    setSelectedId(id);
    if (previewPane.current) previewPane.current.scrollTop = 0;
  }

  async function loadMore() {
    if (!versions || loadingMore) return;
    setLoadingMore(true);
    setListError('');
    try {
      const next = await listNoteVersions(noteId, pageSize, versions.length);
      if (mounted.current) {
        setVersions([...versions, ...next]);
        setHasMore(next.length === pageSize);
      }
    } catch (error) {
      if (mounted.current) setListError(historyErrorMessage(error));
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }

  function refreshVersions() {
    setVersions(undefined);
    setSelectedId('');
    setPreview(undefined);
    setListError('');
    setPreviewError('');
    setReload((count) => count + 1);
  }

  async function restore() {
    if (!preview || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await onRestore(noteId, preview.id);
      if (!mounted.current) return;
      switch (result) {
        case 'restored': setMessage('Version restored.'); refreshVersions(); break;
        case 'saveFailed': setMessage('The workspace could not be saved. Resolve the save issue before restoring.'); break;
        case 'conflict': setMessage('The workspace changed elsewhere. Reopen it before restoring a version.'); break;
        case 'reloadFailed': setMessage('The version was restored. Reopen Kanso to see it.'); break;
      }
    } catch (error) {
      if (mounted.current) setMessage(historyErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const selected = versions?.find((item) => item.id === selectedId);
  return (
    <Dialog.Popup className={`${popup} flex h-[min(40rem,calc(100dvh-1.5rem))] w-[min(52rem,calc(100%-1.5rem))] flex-col overflow-hidden`}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && ['k', 'n'].includes(event.key.toLowerCase())) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}>
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <Dialog.Title className="text-base font-semibold">Version history</Dialog.Title>
          <Dialog.Description className="truncate text-sm text-muted-foreground">{note.name}</Dialog.Description>
        </div>
        <Dialog.Close render={<Button aria-label="Close version history" variant="ghost" size="icon" disabled={busy} />}><X aria-hidden="true" /></Dialog.Close>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label="Saved versions" className="max-h-40 shrink-0 overflow-y-auto border-b border-border bg-sidebar p-2 sm:max-h-none sm:w-52 sm:border-e sm:border-b-0">
          {!versions && !listError && <p role="status" className="p-2 text-sm text-muted-foreground">Loading versions…</p>}
          {versions?.length === 0 && <p className="p-2 text-sm text-muted-foreground">No versions saved for this note.</p>}
          {versions?.map((version) => (
            <button key={version.id} type="button" aria-current={version.id === selectedId ? 'true' : undefined} disabled={busy}
              className="mb-1 block w-full cursor-pointer rounded-md border border-transparent px-2 py-1.5 text-start text-sm hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring aria-current:border-sidebar-border aria-current:bg-sidebar-accent aria-current:font-semibold"
              onClick={() => select(version.id)}>
              <time dateTime={new Date(version.createdAt).toISOString()}>{dateTime.format(version.createdAt)}</time>
              <span className="block text-xs font-normal text-muted-foreground">{reasons[version.reason]}</span>
            </button>
          ))}
          {listError && <p role="alert" className="px-2 py-1 text-sm text-muted-foreground">{listError}</p>}
          {!versions && listError && <Button variant="outline" onClick={refreshVersions}>Retry</Button>}
          {hasMore && <Button variant="ghost" disabled={loadingMore || busy} onClick={() => void loadMore()}>Load more</Button>}
        </nav>
        <div ref={previewPane} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
          {selected && <h2 className="mb-3 text-sm font-semibold">{dateTime.format(selected.createdAt)}</h2>}
          {selectedId && !preview && !previewError && <p role="status" className="text-sm text-muted-foreground">Loading preview…</p>}
          {previewError && <div className="space-y-2">
            <p role="alert" className="text-sm text-muted-foreground">{previewError}</p>
            <Button variant="outline" onClick={() => { setPreviewError(''); setPreviewReload((count) => count + 1); }}>Retry preview</Button>
          </div>}
          {preview && <VersionPreview key={preview.id} version={preview} current={note.content ?? ''} />}
        </div>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
        <p role="status" className="text-sm text-muted-foreground">{busy ? 'Restoring version…' : message}</p>
        <RestoreConfirmation disabled={!preview || busy || loadingMore} onConfirm={() => void restore()} />
      </footer>
    </Dialog.Popup>
  );
}

export function NoteHistoryButton(props: NoteHistoryProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root onOpenChange={(open, details) => { if (!open && busy) details.cancel(); }}>
      <Dialog.Trigger render={<Button variant="ghost" size="icon-xs" aria-label="Version history" title="Version history" className="ms-auto text-muted-foreground" />}>
        <History aria-hidden="true" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className={backdrop} />
        <HistoryContent {...props} busy={busy} setBusy={setBusy} />
      </Dialog.Portal>
    </Dialog.Root>
  );
}
