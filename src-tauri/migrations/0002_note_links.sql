ALTER TABLE workspaces ADD COLUMN wiki_index_ready INTEGER NOT NULL DEFAULT 0;

CREATE TABLE note_links (
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    target_id TEXT,
    target TEXT NOT NULL,
    alias TEXT,
    context TEXT NOT NULL,
    PRIMARY KEY (workspace_id, source_id, start_offset),
    FOREIGN KEY (workspace_id, source_id) REFERENCES notes(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, target_id) REFERENCES notes(workspace_id, id)
);

CREATE INDEX note_links_backlinks ON note_links(workspace_id, target_id, source_id)
    WHERE target_id IS NOT NULL;

CREATE TRIGGER note_links_clear_target BEFORE DELETE ON notes
BEGIN
    UPDATE note_links SET target_id = NULL WHERE workspace_id = OLD.workspace_id AND target_id = OLD.id;
END;
