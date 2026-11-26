import { isolateHistory } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import type { EditorView as SourceEditor } from '@codemirror/view';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment } from '@tiptap/pm/model';
import type { EditorView as VisualEditor } from '@tiptap/pm/view';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { attachmentErrorMessage, importAttachment, importAttachmentFile, type Attachment } from '@/lib/database/attachment-database';
import { serializeAttachmentMarkdown } from '../visual-markdown';
import { importedAttachmentAttrs } from './attachment-markdown';

type ActiveEditor = { mode: 'source'; editor: SourceEditor } | { mode: 'document'; editor: VisualEditor };
type DropPoint = { x: number; y: number };
type InsertionTarget = { mode: ActiveEditor['mode']; position: number };

function capturePosition(active: ActiveEditor, point?: DropPoint) {
  if (active.mode === 'source') {
    return (point ? active.editor.posAtCoords(point) : null) ?? active.editor.state.selection.main.to;
  }
  return (point ? active.editor.posAtCoords({ left: point.x, top: point.y })?.pos : null) ?? active.editor.state.selection.to;
}

function insertAttachments(active: ActiveEditor, position: number, files: Attachment[]) {
  const attachments = files.map(importedAttachmentAttrs);
  if (active.mode === 'source') {
    const { state } = active.editor;
    const line = state.doc.lineAt(position);
    const prefix = position > line.from ? ' ' : '';
    const suffix = position < line.to ? ' ' : '';
    const insert = prefix + attachments.map((attrs) => serializeAttachmentMarkdown(attrs)).join(' ') + suffix;
    active.editor.dispatch({
      changes: { from: position, insert },
      annotations: [Transaction.userEvent.of('input.attach'), isolateHistory.of('full')],
    });
    return;
  }

  const { state } = active.editor;
  const { schema } = state;
  const contents = attachments.flatMap((attrs, index) => [
    ...(index ? [schema.text(' ')] : []), schema.nodes.managed_attachment.create(attrs),
  ]);
  const content = Fragment.fromArray(contents);
  const place = state.doc.resolve(position);
  const inline = place.parent.inlineContent && place.parent.type.validContent(content);
  const transaction = inline ? state.tr.insert(position, content)
    : state.tr.insert(place.depth > 0 ? place.after(1) : position, schema.nodes.paragraph.create(null, content));
  if (transaction.docChanged) {
    active.editor.dispatch(closeHistory(transaction));
    active.editor.dispatch(closeHistory(active.editor.state.tr));
  }
}

export function useAttachmentInsertion(
  noteId: string,
  prepare: () => Promise<boolean>,
  getActiveEditor: () => ActiveEditor | null,
) {
  const latest = useRef(getActiveEditor);
  const mounted = useRef(false);
  const target = useRef<InsertionTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useLayoutEffect(() => { latest.current = getActiveEditor; });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      target.current = null;
    };
  }, []);

  const run = useCallback(async (files?: File[], point?: DropPoint) => {
    const active = latest.current();
    if (!active || target.current) return;
    const pending = { mode: active.mode, position: capturePosition(active, point) };
    target.current = pending;
    setBusy(true);
    setMessage('Importing attachment…');
    const imported: Attachment[] = [];
    const errors: string[] = [];
    try {
      if (!await prepare()) {
        setMessage('Save the note before attaching a file.');
        return;
      }
      if (!mounted.current) return;
      if (files) {
        for (const file of files) {
          if (!mounted.current) break;
          try {
            imported.push(await importAttachmentFile(noteId, file));
          } catch (error) {
            errors.push(`${file.name}: ${attachmentErrorMessage(error)}`);
          }
        }
      } else {
        const picked = await importAttachment(noteId);
        if (picked) imported.push(picked);
      }

      const current = latest.current();
      if (!mounted.current || !current) return;
      target.current = null;
      if (imported.length) {
        const position = current.mode === pending.mode ? pending.position : capturePosition(current);
        insertAttachments(current, position, imported);
      }
      setMessage(errors.join(' '));
    } catch (error) {
      if (mounted.current) setMessage(attachmentErrorMessage(error));
    } finally {
      if (mounted.current) {
        target.current = null;
        setBusy(false);
      }
    }
  }, [noteId, prepare]);

  return {
    busy, message, run,
    mapPosition(mode: ActiveEditor['mode'], map: (position: number) => number) {
      if (target.current?.mode === mode) target.current.position = map(target.current.position);
    },
  };
}
