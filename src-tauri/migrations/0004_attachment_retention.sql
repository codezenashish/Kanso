CREATE TABLE retained_attachment_refs (
    workspace_id TEXT NOT NULL,
    retention_key TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, retention_key, attachment_id),
    FOREIGN KEY (workspace_id, attachment_id) REFERENCES attachments(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX retained_attachment_refs_by_attachment ON retained_attachment_refs(workspace_id, attachment_id);
