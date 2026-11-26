CREATE TABLE note_versions (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    note_name TEXT NOT NULL,
    note_format TEXT NOT NULL CHECK (note_format IN ('markdown', 'text', 'yaml')),
    content TEXT NOT NULL DEFAULT '',
    properties TEXT CHECK (properties IS NULL OR json_valid(properties)),
    content_digest TEXT NOT NULL CHECK (length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
    reason TEXT NOT NULL DEFAULT 'autosave' CHECK (reason IN ('autosave', 'restore_checkpoint', 'manual')),
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, note_id) REFERENCES notes(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX note_versions_by_note ON note_versions(workspace_id, note_id, created_at DESC);

CREATE TABLE note_version_attachments (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, version_id, attachment_id),
    FOREIGN KEY (workspace_id, version_id) REFERENCES note_versions(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, attachment_id) REFERENCES attachments(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX note_version_attachments_by_attachment ON note_version_attachments(workspace_id, attachment_id);

CREATE TABLE version_history_config (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    snapshot_interval_ms INTEGER NOT NULL DEFAULT 300000 CHECK (snapshot_interval_ms >= 0),
    max_versions_per_note INTEGER NOT NULL DEFAULT 50 CHECK (max_versions_per_note >= 1),
    max_age_days INTEGER CHECK (max_age_days IS NULL OR max_age_days >= 1)
);

CREATE TRIGGER note_versions_release_retained_attachments AFTER DELETE ON note_versions
BEGIN
    DELETE FROM retained_attachment_refs
    WHERE workspace_id = OLD.workspace_id
      AND retention_key = 'version:' || OLD.id;
END;

CREATE TRIGGER notes_release_version_retained_attachments BEFORE DELETE ON notes
BEGIN
    DELETE FROM retained_attachment_refs
    WHERE workspace_id = OLD.workspace_id
      AND retention_key IN (
          SELECT 'version:' || id
          FROM note_versions
          WHERE workspace_id = OLD.workspace_id AND note_id = OLD.id
      );
END;
