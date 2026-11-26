import { invoke } from '@tauri-apps/api/core';

export type Attachment = {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
};

export function importAttachment(noteId: string) {
  return invoke<Attachment | null>('import_attachment', { noteId });
}

export function resolveAttachment(noteId: string, attachmentId: string) {
  return invoke<Attachment>('resolve_attachment', { noteId, attachmentId });
}

export function openAttachment(noteId: string, attachmentId: string) {
  return invoke<void>('open_attachment', { noteId, attachmentId });
}

export const maxAttachmentBytes = 25 * 1024 * 1024;

export async function importAttachmentFile(noteId: string, file: File) {
  if (file.size > maxAttachmentBytes) throw 'fileTooLarge';
  if (!file.size) throw 'invalidFile';
  return invoke<Attachment>('import_attachment_bytes', await file.arrayBuffer(), {
    headers: { 'x-kanso-note-id': encodeURIComponent(noteId), 'x-kanso-filename': encodeURIComponent(file.name) },
  });
}

export async function readAttachmentImage(noteId: string, attachmentId: string) {
  const bytes = await invoke<ArrayBuffer | number[]>('read_attachment_image', { noteId, attachmentId });
  return new Blob([Array.isArray(bytes) ? new Uint8Array(bytes) : bytes]);
}

export function attachmentErrorMessage(error: unknown) {
  switch (error) {
    case 'fileTooLarge': return 'Attachments can be up to 25 MiB.';
    case 'unsupportedType': return 'Use a PNG, JPEG, GIF, WebP, PDF, or plain text file.';
    case 'invalidFile': return 'This file could not be read.';
    case 'managedFileMissing': return 'The attachment file is missing.';
    case 'managedFileInvalid': return 'The attachment file could not be verified.';
    case 'attachmentNotFound': return 'This attachment is unavailable in this note.';
    case 'noteNotAvailable': return 'Save the note before attaching a file.';
    case 'cleanupChanged': return 'The cleanup list changed. Review the refreshed list and try again.';
    case 'invalidBackup': return 'Choose the workspace.json file from a complete Kanso backup.';
    case 'backupTooLarge': return 'The backup manifest exceeds 128 MiB.';
    case 'openFailed': return 'The attachment could not be opened.';
    default: return 'The attachment could not be accessed.';
  }
}

export type AttachmentStorage = {
  location: string;
  maxFileBytes: number;
  fileCount: number;
  totalBytes: number;
  unusedFileCount: number;
  unusedRecordCount: number;
  unusedBytes: number;
  cleanupToken: string;
  attachments: (Attachment & { noteCount: number; retainedCount: number })[];
};

export const loadAttachmentStorage = () => invoke<AttachmentStorage>('attachment_storage');
export const cleanupAttachmentStorage = (token: string) => invoke<AttachmentStorage>('cleanup_attachments', { token });
export const exportAttachmentBackup = () => invoke<string | null>('export_attachment_backup');
export const restoreAttachmentBackup = () => invoke<number | null>('restore_attachment_backup');
