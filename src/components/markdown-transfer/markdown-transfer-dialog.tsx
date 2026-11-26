import { Dialog } from '@base-ui/react/dialog';
import { useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useWorkspaceToast } from '@/components/ui/workspace-toasts';
import type { useWorkspace } from '@/hooks/use-workspace';
import { attachmentErrorMessage, importAttachmentFile } from '@/lib/database/attachment-database';
import {
  exportMarkdownFiles, pickMarkdownImport, portableAssetReferences,
  type ImportBatch, type ImportChoice,
} from '@/lib/markdown-transfer';
import { listDestinationFolders } from '@/lib/template-note';
import { find } from '@/lib/workspace-tree';

export type MarkdownTransferRequest =
  | { mode: 'import'; destination: string | null; dropped?: Promise<ImportBatch> }
  | { mode: 'export'; id: string | null; chooseFolders?: boolean };

type TransferReport = { message: string; issues: string[]; directory?: string };
type DialogProps = {
  request: MarkdownTransferRequest;
  workspace: ReturnType<typeof useWorkspace>;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'The operation could not be completed.';
}

export function MarkdownTransferDialog({ request, workspace, returnFocus, onClose }: DialogProps) {
  const { notify } = useWorkspaceToast();
  const [open, setOpen] = useState(true);
  const [destination, setDestination] = useState(request.mode === 'import' ? request.destination : null);
  const [choice, setChoice] = useState<ImportChoice>('rename');
  const [batch, setBatch] = useState<ImportBatch>();
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [includeTrash, setIncludeTrash] = useState(false);
  const [progress, setProgress] = useState('');
  const [report, setReport] = useState<TransferReport>();
  const [dropAvailable, setDropAvailable] = useState(request.mode === 'import' && !!request.dropped);
  const busy = useRef(false);
  const selected = request.mode === 'export' && request.id ? find(workspace.allNodes, request.id) : null;

  async function run(message: string, work: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setProgress(message);
    setReport(undefined);
    try {
      await work();
    } catch (error) {
      const message = errorMessage(error);
      setReport({ message, issues: [] });
      notify({ key: 'markdown-transfer', kind: 'error', message });
    } finally {
      busy.current = false;
      setProgress('');
    }
  }

  async function loadBatch(folders?: boolean) {
    await run('Reading Markdown files…', async () => {
      const imported = folders === undefined && request.mode === 'import'
        ? await request.dropped : await pickMarkdownImport(Boolean(folders));
      if (imported) {
        setBatch(imported);
        setDropAvailable(false);
        if (!imported.entries.length) setReport({ message: 'No readable Markdown files or folders were found.', issues: imported.issues });
      } else setReport({ message: 'File selection canceled.', issues: [] });
    });
  }

  function finish(result: TransferReport) {
    setReport(result);
    notify({ key: 'markdown-transfer', kind: result.issues.length ? 'info' : 'success', message: result.message });
  }

  async function importBatch() {
    if (!batch) return;
    await run('Saving imported notes…', async () => {
      if (!await workspace.flushWorkspace()) throw new Error('Save or recover your pending workspace changes before importing.');
      const plan = flushSync(() => workspace.importMarkdownBatch(batch, destination, choice));
      setBatch(undefined);
      if (!plan.imported.length && !plan.folderCount) {
        finish({ message: 'No new notes or folders were imported.', issues: plan.issues });
        return;
      }
      if (!await workspace.flushWorkspace()) {
        throw new Error('The import is staged in the workspace but could not be saved. Use Retry save before leaving.');
      }
      const issues = [...plan.issues];
      const rewritten: { id: string; original: string; content: string }[] = [];
      for (const [index, { node, entry }] of plan.imported.entries()) {
        const original = entry.content ?? '';
        const { references, unresolved } = portableAssetReferences(original);
        for (const url of unresolved) issues.push(`${node.name}: kept unresolved local link ${url}.`);
        if (!references.length) continue;
        setProgress(`Importing local attachments for note ${index + 1} of ${plan.imported.length}…`);
        const assets = new Map(entry.assets.map(({ name, bytes }) => [name, bytes]));
        const ids = new Map<string, string>();
        for (const name of new Set(references.map((reference) => reference.name))) {
          const bytes = assets.get(name);
          if (!bytes) {
            issues.push(`${node.name}: attachment ${name} was unavailable. Its original link was kept.`);
            continue;
          }
          try {
            const attachment = await importAttachmentFile(node.id, new File([new Uint8Array(bytes)], name));
            ids.set(name, attachment.id);
          } catch (error) {
            issues.push(`${node.name}: ${name}: ${attachmentErrorMessage(error)}`);
          }
        }
        let content = original;
        for (const { name, start, end, fragment } of references.sort((first, second) => second.start - first.start)) {
          const id = ids.get(name);
          if (id) content = content.slice(0, start) + `attachment:${id}${fragment}` + content.slice(end);
        }
        if (content !== original) rewritten.push({ id: node.id, original, content });
      }
      if (rewritten.length) {
        flushSync(() => {
          for (const { id, original, content } of rewritten) {
            if (!workspace.replaceImportedMarkdown(id, original, content)) issues.push(`Kept concurrent edits in imported note ${id}.`);
          }
        });
        if (!await workspace.flushWorkspace()) {
          issues.push('Notes were imported, but attachment links could not be saved. Use Retry save before leaving.');
        }
      }
      const summary = `Imported ${plan.imported.length} notes and ${plan.folderCount} folders.`;
      finish({ message: issues.length ? summary + ' Review the import details.' : summary, issues });
    });
  }

  async function exportSelection() {
    if (request.mode !== 'export') return;
    await run('Preparing Markdown export…', async () => {
      if (!await workspace.flushWorkspace()) throw new Error('Save or recover your pending workspace changes before exporting.');
      const plan = workspace.prepareMarkdownExport(request.chooseFolders ? selectedFolders : request.id, includeTrash);
      if (!plan.entries.length) throw new Error('There are no available notes or folders in this export.');
      const report = await exportMarkdownFiles(plan.entries);
      if (!report) {
        setReport({ message: 'Export canceled.', issues: [] });
        return;
      }
      const issues = [...plan.issues, ...report.issues];
      const summary = `Exported ${report.written} files.`;
      finish({ message: issues.length ? summary + ' Review the export details.' : summary, issues, directory: report.directory });
    });
  }

  function close(nextOpen: boolean) {
    if (!nextOpen && !busy.current) setOpen(false);
  }

  const fieldClass = 'min-h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring';
  const count = batch?.entries.filter(({ content }) => content !== null).length ?? 0;
  const folders = listDestinationFolders(workspace.allNodes);
  const exportDescription = request.mode === 'export' && request.chooseFolders ? 'the selected folders'
    : selected ? `“${selected.name}”` : 'the workspace';

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen, details) => {
      if (!nextOpen && busy.current) details.cancel();
      else close(nextOpen);
    }} onOpenChangeComplete={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-foreground/25" />
        <Dialog.Popup finalFocus={() => returnFocus.current?.isConnected ? returnFocus.current : true}
          className="fixed inset-x-3 top-1/2 z-50 mx-auto max-h-[calc(100dvh-1.5rem)] max-w-lg -translate-y-1/2 space-y-3 overflow-y-auto rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl">
          <Dialog.Title className="text-lg font-semibold">{request.mode === 'import' ? 'Import Markdown' : 'Export Markdown'}</Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">
            {request.mode === 'import'
              ? 'Choose a workspace folder and how to handle duplicate names. Existing notes are kept.'
              : `Export ${exportDescription} to a new folder in the location you choose.`}
          </Dialog.Description>
          <fieldset disabled={!!progress} className="space-y-3">
            {request.mode === 'import' ? (
              <>
                <label className="block space-y-1 text-sm">
                  <span>Import into</span>
                  <Select className={fieldClass} value={destination ?? ''} options={[
                    { value: '', label: 'Workspace root' }, ...folders.map((folder) => ({ value: folder.id, label: folder.path })),
                  ]} onValueChange={(value) => setDestination(value || null)} />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Duplicates</span>
                  <Select className={fieldClass} value={choice} options={[
                    { value: 'rename', label: 'Keep both by renaming the import' }, { value: 'skip', label: 'Skip duplicates' },
                  ]} onValueChange={(value) => setChoice(value === 'skip' ? 'skip' : 'rename')} />
                </label>
                <div className="flex flex-wrap gap-2">
                  {dropAvailable && <Button type="button" variant="outline" onClick={() => void loadBatch()}>Review dropped items</Button>}
                  <Button type="button" variant="outline" onClick={() => void loadBatch(false)}>Choose files</Button>
                  <Button type="button" variant="outline" onClick={() => void loadBatch(true)}>Choose folders</Button>
                </div>
                {!!batch?.entries.length && (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm">{count} notes and {batch.entries.length - count} folders ready to import.</p>
                    <Button type="button" onClick={() => void importBatch()}>Import</Button>
                  </div>
                )}
              </>
            ) : (
              <>
                {request.chooseFolders && (
                  <fieldset className="max-h-38 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                    <legend className="px-1 text-sm">Folders to export</legend>
                    {folders.map((folder) => (
                      <label key={folder.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={selectedFolders.includes(folder.id)} onChange={(event) => {
                          setSelectedFolders(event.target.checked
                            ? [...selectedFolders, folder.id] : selectedFolders.filter((id) => id !== folder.id));
                        }} />
                        {folder.path}
                      </label>
                    ))}
                  </fieldset>
                )}
                {!request.id && !request.chooseFolders && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={includeTrash} onChange={(event) => setIncludeTrash(event.target.checked)} />
                    Include Trash
                  </label>
                )}
                <Button type="button" disabled={request.chooseFolders && !selectedFolders.length}
                  onClick={() => void exportSelection()}>Choose export folder</Button>
              </>
            )}
          </fieldset>
          {progress && <p role="status" className="text-sm text-muted-foreground">{progress}</p>}
          {report && (
            <div className="space-y-1 rounded-md border border-border p-2 text-sm">
              <p role="status">{report.message}</p>
              {report.directory && <p className="wrap-break-word text-muted-foreground">{report.directory}</p>}
              {!!report.issues.length && (
                <ul aria-label="Transfer details" className="max-h-40 list-disc overflow-y-auto ps-5 text-xs text-muted-foreground">
                  {report.issues.map((issue, index) => <li key={index} className="wrap-break-word">{issue}</li>)}
                </ul>
              )}
            </div>
          )}
          <div className="flex justify-end">
            <Dialog.Close render={<Button type="button" variant="ghost" disabled={!!progress} />}>Close</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
