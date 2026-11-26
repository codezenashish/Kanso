CREATE TABLE attachments (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    PRIMARY KEY (workspace_id, id),
    UNIQUE (workspace_id, digest, original_filename)
);

CREATE TABLE note_attachments (
    workspace_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, note_id, attachment_id),
    FOREIGN KEY (workspace_id, note_id) REFERENCES notes(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, attachment_id) REFERENCES attachments(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX note_attachments_by_attachment ON note_attachments(workspace_id, attachment_id);
