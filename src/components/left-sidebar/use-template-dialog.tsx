import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { isTauri } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import type { CreateFromTemplateOptions } from '@/hooks/use-workspace';
import { resolveAttachment } from '@/lib/database/attachment-database';
import {
  defaultTemplateNoteName,
  extractTemplateAttachmentIds,
  listDestinationFolders,
  resolveTemplateNotePlan,
} from '@/lib/template-note';
import type { WorkspaceNode } from '@/lib/workspace-tree';

const backdrop = 'fixed inset-0 z-30 bg-black/45';
const popup = 'fixed top-1/2 left-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background text-foreground shadow-xl';
const fieldClass = 'min-h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';

type UseTemplateDialogProps = {
  template: WorkspaceNode | null;
  tree: WorkspaceNode[];
  flushWorkspace: () => Promise<boolean>;
  restoreFocusTarget: HTMLElement | null;
  onClose: () => void;
  onCreate: (templateId: string, options: CreateFromTemplateOptions) => WorkspaceNode | null;
  onCreated?: (note: WorkspaceNode) => void;
};

type AttachmentCheckState =
  | { status: 'none' }
  | { status: 'checking'; total: number }
  | { status: 'unchecked'; total: number }
  | { status: 'checked'; total: number; valid: number; invalid: number };

function attachmentSummaryText(state: AttachmentCheckState) {
  switch (state.status) {
    case 'none':
      return null;
    case 'checking':
      return `Verifying ${state.total} attachment ${state.total === 1 ? 'reference' : 'references'}…`;
    case 'unchecked':
      return `${state.total} attachment ${state.total === 1 ? 'reference' : 'references'} in template content.`;
    case 'checked':
      if (state.invalid === 0) {
        return `${state.valid} valid attachment ${state.valid === 1 ? 'reference' : 'references'} will be preserved.`;
      }
      if (state.valid > 0) {
        return `${state.valid} valid attachment ${state.valid === 1 ? 'reference' : 'references'} will be preserved. ${state.invalid} unavailable ${state.invalid === 1 ? 'reference' : 'references'} could not be verified.`;
      }
      return `${state.invalid} attachment ${state.invalid === 1 ? 'reference' : 'references'} could not be verified and may not load in the new note.`;
  }
}

function UseTemplateForm({
  template,
  tree,
  flushWorkspace,
  restoreFocusTarget,
  onClose,
  onCreate,
  onCreated,
}: Omit<UseTemplateDialogProps, 'template'> & { template: WorkspaceNode }) {
  const nameId = useId();
  const folderId = useId();
  const feedbackId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const createdRef = useRef(false);

  const [destinationFolderId, setDestinationFolderId] = useState<string | null>(null);
  const [name, setName] = useState(() => defaultTemplateNoteName(template.name, null, tree));
  const [nameEdited, setNameEdited] = useState(false);

  const folders = useMemo(() => listDestinationFolders(tree), [tree]);
  const attachmentIds = useMemo(
    () => extractTemplateAttachmentIds(template.content ?? ''),
    [template.content],
  );
  const [attachmentCheck, setAttachmentCheck] = useState<AttachmentCheckState>(() => {
    if (!attachmentIds.length) return { status: 'none' };
    return isTauri()
      ? { status: 'checking', total: attachmentIds.length }
      : { status: 'unchecked', total: attachmentIds.length };
  });

  useEffect(() => {
    if (!attachmentIds.length) {
      setAttachmentCheck({ status: 'none' });
      return;
    }
    if (!isTauri()) {
      setAttachmentCheck({ status: 'unchecked', total: attachmentIds.length });
      return;
    }
    let active = true;
    setAttachmentCheck({ status: 'checking', total: attachmentIds.length });
    void (async () => {
      await flushWorkspace();
      const results = await Promise.allSettled(
        attachmentIds.map((attachmentId) => resolveAttachment(template.id, attachmentId)),
      );
      if (!active) return;
      const valid = results.filter((result) => result.status === 'fulfilled').length;
      setAttachmentCheck({
        status: 'checked',
        total: attachmentIds.length,
        valid,
        invalid: attachmentIds.length - valid,
      });
    })();
    return () => { active = false; };
  }, [attachmentIds, flushWorkspace, template.id]);

  const plan = useMemo(
    () => resolveTemplateNotePlan({
      templateName: template.name,
      rawName: name,
      destinationFolderId,
      tree,
    }),
    [destinationFolderId, name, template.name, tree],
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!plan.valid) return;
    const created = onCreate(template.id, { name, parentId: destinationFolderId });
    if (!created) return;
    createdRef.current = true;
    onCreated?.(created);
    onClose();
  }

  const propertyCount = template.properties?.length ?? 0;
  const attachmentText = attachmentSummaryText(attachmentCheck);

  return (
    <Dialog.Popup
      initialFocus={(interaction) => interaction === 'touch' ? true : nameInputRef.current}
      finalFocus={() => createdRef.current ? false : (restoreFocusTarget ?? true)}
      className={`${popup} w-[min(29rem,calc(100%-1.5rem))] overflow-hidden`}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && ['k', 'n', 's'].includes(event.key.toLowerCase())) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <Dialog.Title className="text-base font-semibold">Create note from template</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">
            Create a new note using “{template.name}”. The original template will remain unchanged.
          </Dialog.Description>
        </div>
        <Dialog.Close render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Close template dialog" title="Close" />}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </header>
      <form onSubmit={submit} className="space-y-4 px-5 py-4">
        <div className="space-y-1.5">
          <label htmlFor={nameId} className="block text-sm font-medium">Note name</label>
          <input
            ref={nameInputRef}
            id={nameId}
            type="text"
            className={fieldClass}
            value={name}
            aria-invalid={!plan.valid}
            aria-describedby={(!plan.valid || plan.collided) ? feedbackId : undefined}
            onChange={(event) => {
              setNameEdited(true);
              setName(event.target.value);
            }}
          />
          {!plan.valid && (
            <p id={feedbackId} role="alert" className="text-xs text-destructive">
              {plan.error}
            </p>
          )}
          {plan.valid && plan.collided && (
            <p id={feedbackId} role="status" className="text-xs text-muted-foreground">
              “{plan.requestedName}” already exists in {plan.destinationPath}. The new note will be saved as “{plan.resolvedName}”.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor={folderId} className="block text-sm font-medium">Destination folder</label>
          <Select id={folderId} className={`${fieldClass} cursor-pointer`} value={destinationFolderId ?? ''}
            options={[{ value: '', label: 'Workspaces (root)' }, ...folders.map((folder) => ({ value: folder.id, label: folder.path }))]}
            onValueChange={(value) => {
              const nextFolderId = value || null;
              setDestinationFolderId(nextFolderId);
              if (!nameEdited) setName(defaultTemplateNoteName(template.name, nextFolderId, tree));
            }} />
        </div>

        <div className="space-y-1 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          <p>
            Preserves template content{propertyCount > 0 ? ` and ${propertyCount} ${propertyCount === 1 ? 'property' : 'properties'}` : ''}.
          </p>
          {attachmentText && (
            <p role={attachmentCheck.status === 'checked' && attachmentCheck.invalid > 0 ? 'status' : undefined}>
              {attachmentText}
            </p>
          )}
        </div>

        <footer className="flex flex-wrap justify-end gap-2 pt-1">
          <Dialog.Close render={<Button type="button" variant="outline" />}>Cancel</Dialog.Close>
          <Button type="submit" disabled={!plan.valid || attachmentCheck.status === 'checking'}>
            Create note
          </Button>
        </footer>
      </form>
    </Dialog.Popup>
  );
}

export function UseTemplateDialog({
  template,
  tree,
  flushWorkspace,
  restoreFocusTarget,
  onClose,
  onCreate,
  onCreated,
}: UseTemplateDialogProps) {
  return (
    <Dialog.Root open={Boolean(template)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className={backdrop} />
        {template && (
          <UseTemplateForm
            key={template.id}
            template={template}
            tree={tree}
            flushWorkspace={flushWorkspace}
            restoreFocusTarget={restoreFocusTarget}
            onClose={onClose}
            onCreate={onCreate}
            onCreated={onCreated}
          />
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}
