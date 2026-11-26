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

export type TabSession = {
  active: string;
  openFiles: string[];
  pinnedFiles: string[];
};

export type WorkspaceSnapshot = TabSession & {
  tree: WorkspaceNode[];
  wiki: WikiIndex;
  managedTags: string[];
  expanded: string[];
};
