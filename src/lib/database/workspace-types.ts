import type { WikiIndex } from '../wiki-index';

export type NoteProperty = { name: string; value: string };

export type WorkspaceNode = {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  content?: string;
  properties?: NoteProperty[];
  starred?: boolean;
  template?: boolean;
  status?: 'archived' | 'trashed';
  lastOpenedAt?: number;
  children?: WorkspaceNode[];
};

export type WorkspaceSnapshot = {
  tree: WorkspaceNode[];
  wiki: WikiIndex;
  active: string;
  openFiles: string[];
  expanded: string[];
};
