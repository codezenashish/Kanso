import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  attachmentErrorMessage, cleanupAttachmentStorage, exportAttachmentBackup,
  loadAttachmentStorage, restoreAttachmentBackup, type AttachmentStorage,
} from '@/lib/database/attachment-database';

export type AttachmentSettingsProps = {
  onPrepareAttachmentOperation: () => Promise<boolean>;
  onReloadWorkspace: () => Promise<boolean>;
};

const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${formatter.format(bytes / 1024)} KiB`;
  if (bytes < 1024 ** 3) return `${formatter.format(bytes / 1024 ** 2)} MiB`;
  return `${formatter.format(bytes / 1024 ** 3)} GiB`;
}

function ConfirmAttachmentAction({ disabled, label, title, description, destructive, onConfirm }: {
  disabled: boolean;
  label: string;
  title: string;
  description: ReactNode;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger render={<Button variant="outline" disabled={disabled} />}>{label}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-30 bg-black/45" />
        <AlertDialog.Popup initialFocus={cancel} className="fixed top-1/2 left-1/2 z-30 w-[min(25rem,calc(100%-1.5rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-5 text-foreground shadow-xl">
          <AlertDialog.Title className="text-base font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">{description}</AlertDialog.Description>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <AlertDialog.Close render={<Button ref={cancel} variant="outline" />}>Cancel</AlertDialog.Close>
            <AlertDialog.Close render={<Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} />}>{label}</AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function AttachmentSettings({ onPrepareAttachmentOperation, onReloadWorkspace, onBusyChange }: AttachmentSettingsProps & { onBusyChange: (busy: boolean) => void }) {
  const [storage, setStorage] = useState<AttachmentStorage>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    void loadAttachmentStorage().then(
      (summary) => { if (current) setStorage(summary); },
      (error) => { if (current) setMessage(attachmentErrorMessage(error)); },
    );
    return () => { mounted.current = false; current = false; };
  }, []);

  async function run(action: 'refresh' | 'cleanup' | 'export' | 'restore') {
    setBusy(true);
    onBusyChange(true);
    setMessage('');
    try {
      if (action !== 'refresh' && !await onPrepareAttachmentOperation()) {
        setMessage('Save the workspace before continuing.');
        return;
      }
      if (action === 'cleanup' && storage) {
        setStorage(await cleanupAttachmentStorage(storage.cleanupToken));
        setMessage('Unused attachments removed.');
      } else if (action === 'export') {
        const path = await exportAttachmentBackup();
        if (path !== null) setMessage(`Backup created in ${path}`);
      } else if (action === 'restore') {
        const restored = await restoreAttachmentBackup();
        if (restored !== null) {
          const reloaded = await onReloadWorkspace();
          if (mounted.current) setMessage(reloaded ? `Restored notes: ${restored}.` : 'The backup was restored. Reopen Kanso to see the notes.');
          if (mounted.current) setStorage(await loadAttachmentStorage());
        }
      } else {
        setStorage(await loadAttachmentStorage());
      }
    } catch (error) {
      if (!mounted.current) return;
      setMessage(attachmentErrorMessage(error));
      if (action === 'cleanup') {
        try {
          setStorage(await loadAttachmentStorage());
        } catch {
          setStorage(undefined);
        }
      }
    } finally {
      onBusyChange(false);
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="space-y-4 py-4">
      {storage && (
        <dl className="space-y-2 text-sm">
          <div><dt className="font-medium">Managed location</dt><dd className="mt-0.5 select-all wrap-anywhere text-muted-foreground">{storage.location}</dd></div>
          <div><dt className="font-medium">File limit</dt><dd className="text-muted-foreground">{formatBytes(storage.maxFileBytes)} per attachment</dd></div>
          <div><dt className="font-medium">Storage used</dt><dd className="text-muted-foreground">{formatBytes(storage.totalBytes)} across {storage.fileCount} files</dd></div>
        </dl>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void run('refresh')}>Refresh usage</Button>
        <ConfirmAttachmentAction disabled={busy || !storage || !(storage.unusedRecordCount || storage.unusedFileCount)}
          label="Remove unused attachments" title="Remove unused attachments?" destructive
          description={`Remove ${storage?.unusedFileCount ?? 0} unused files (${formatBytes(storage?.unusedBytes ?? 0)}) and ${storage?.unusedRecordCount ?? 0} unused attachment records. Open tabs, notes in Trash, and retained references are protected.`}
          onConfirm={() => void run('cleanup')} />
      </div>
      {!!storage?.attachments.length && (
        <details className="rounded-md border border-border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-ring">Managed attachments ({storage.attachments.length})</summary>
          <ul className="mt-2 divide-y divide-border">
            {storage.attachments.map((file) => (
              <li key={file.id} className="py-2">
                <p className="wrap-anywhere">{file.originalFilename}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.sizeBytes)} · Notes: {file.noteCount} · Retained references: {file.retainedCount}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="space-y-2 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">Portable backup</h3>
        <p className="text-sm text-muted-foreground">Export notes, version history, and attachment files together. Restore uses the manifest and adds a Recovered workspace folder.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void run('export')}>Export backup</Button>
          <ConfirmAttachmentAction disabled={busy} label="Restore backup" title="Restore a Kanso backup?"
            description="Select the backup’s workspace.json. Recovered notes and attachments will be added alongside your current workspace."
            onConfirm={() => void run('restore')} />
        </div>
      </div>
      <p role="status" className={message || busy ? 'wrap-anywhere text-sm text-muted-foreground' : 'sr-only'}>
        {busy ? 'Working with attachment storage…' : message}
      </p>
    </div>
  );
}
