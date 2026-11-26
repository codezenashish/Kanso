import { invoke } from '@tauri-apps/api/core';
import type { NoteProperty } from './workspace-types';

export type VersionSnapshotReason = 'autosave' | 'restore_checkpoint' | 'manual';

export type HistoryConfig = {
  enabled: boolean;
  snapshotIntervalMs: number;
  maxVersionsPerNote: number;
  maxAgeDays: number | null;
};

export type NoteVersionSummary = {
  id: string;
  noteId: string;
  createdAt: number;
  noteName: string;
  noteFormat: 'markdown' | 'text' | 'yaml';
  reason: VersionSnapshotReason;
  contentBytes: number;
  preview: string;
  hasProperties: boolean;
  attachmentIds: string[];
};

export type NoteVersionDetail = {
  id: string;
  noteId: string;
  createdAt: number;
  noteName: string;
  noteFormat: 'markdown' | 'text' | 'yaml';
  content: string;
  properties: NoteProperty[] | null;
  reason: VersionSnapshotReason;
  contentDigest: string;
  attachmentIds: string[];
};

export type RetentionPruneResult = {
  deletedVersions: number;
  releasedAttachmentRefs: number;
};

export type RestoredNoteVersion = {
  revision: number;
  noteId: string;
  restoredVersionId: string;
  checkpointVersionId: string | null;
  noteName: string;
  noteFormat: 'markdown' | 'text' | 'yaml';
  content: string;
  properties: NoteProperty[] | null;
  tags: string[];
  attachmentIds: string[];
};

export function listNoteVersions(noteId: string, limit?: number, offset?: number) {
  return invoke<NoteVersionSummary[]>('list_note_versions', { noteId, limit, offset });
}

export function getNoteVersion(noteId: string, versionId: string) {
  return invoke<NoteVersionDetail>('get_note_version', { noteId, versionId });
}

export function createNoteVersion(noteId: string) {
  return invoke<NoteVersionDetail | null>('create_note_version', { noteId });
}

export function pruneNoteVersions(options?: {
  noteId?: string;
  maxVersionsPerNote?: number;
  maxAgeDays?: number;
}) {
  return invoke<RetentionPruneResult>('prune_note_versions', options ?? {});
}

export function getVersionHistoryConfig() {
  return invoke<HistoryConfig>('get_version_history_config');
}

export function updateVersionHistoryConfig(config: HistoryConfig, applyRetention = false) {
  return invoke<HistoryConfig>('update_version_history_config', { config, applyRetention });
}

export function restoreNoteVersion(
  noteId: string,
  versionId: string,
  expectedRevision: number,
  preserveCurrent = true,
) {
  return invoke<RestoredNoteVersion | null>('restore_note_version', {
    noteId,
    versionId,
    expectedRevision,
    preserveCurrent,
  });
}

export function historyErrorMessage(error: unknown) {
  switch (error) {
    case 'noteNotFound': return 'This note could not be found.';
    case 'noteTrashed': return 'Restore this note from Trash before restoring a version.';
    case 'versionNotFound': return 'This version snapshot is no longer available.';
    case 'invalidConfig': return 'Version history settings are invalid.';
    default: return 'Version history could not be accessed.';
  }
}
