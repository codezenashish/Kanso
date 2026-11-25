CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    legacy_digest TEXT,
    expanded TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(expanded))
);

CREATE TABLE folders (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    deleted_at INTEGER,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, parent_id) REFERENCES folders(workspace_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE notes (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('markdown', 'text', 'yaml')),
    content TEXT,
    properties TEXT CHECK (json_valid(properties)),
    starred INTEGER NOT NULL CHECK (starred IN (0, 1)),
    template INTEGER NOT NULL CHECK (template IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_opened_at INTEGER,
    archived_at INTEGER,
    deleted_at INTEGER,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, parent_id) REFERENCES folders(workspace_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE tags (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (workspace_id, name)
);

CREATE TABLE note_tags (
    workspace_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    tag_name TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (workspace_id, note_id, tag_name),
    FOREIGN KEY (workspace_id, note_id) REFERENCES notes(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, tag_name) REFERENCES tags(workspace_id, name) ON DELETE CASCADE
);

CREATE TABLE editor_sessions (
    workspace_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    PRIMARY KEY (workspace_id, note_id),
    UNIQUE (workspace_id, position),
    FOREIGN KEY (workspace_id, note_id) REFERENCES notes(workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX editor_sessions_active ON editor_sessions(workspace_id) WHERE active = 1;
CREATE INDEX folders_parent ON folders(workspace_id, parent_id, position);
CREATE INDEX notes_parent ON notes(workspace_id, parent_id, position);
CREATE INDEX notes_status ON notes(workspace_id, deleted_at, archived_at);
CREATE INDEX note_tags_tag ON note_tags(workspace_id, tag_name);
