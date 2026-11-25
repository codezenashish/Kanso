INSERT INTO folders (workspace_id, id, parent_id, name, position, created_at, updated_at, archived_at, deleted_at)
SELECT ?1, value->>'id', value->>'parent', value->>'name', value->>'position',
       unixepoch('subsec') * 1000, unixepoch('subsec') * 1000,
       CASE WHEN value->>'status' = 'archived' THEN unixepoch('subsec') * 1000 END,
       CASE WHEN value->>'status' = 'trashed' THEN unixepoch('subsec') * 1000 END
FROM json_each(?2, '$.nodes') WHERE value->>'kind' = 'folder'
ON CONFLICT(workspace_id, id) DO UPDATE SET
    parent_id = excluded.parent_id, name = excluded.name, position = excluded.position,
    updated_at = excluded.updated_at,
    archived_at = CASE WHEN excluded.archived_at IS NOT NULL THEN coalesce(folders.archived_at, excluded.archived_at) END,
    deleted_at = CASE WHEN excluded.deleted_at IS NOT NULL THEN coalesce(folders.deleted_at, excluded.deleted_at) END
WHERE (folders.parent_id, folders.name, folders.position, folders.archived_at IS NULL, folders.deleted_at IS NULL)
   IS NOT (excluded.parent_id, excluded.name, excluded.position, excluded.archived_at IS NULL, excluded.deleted_at IS NULL);

INSERT INTO notes (workspace_id, id, parent_id, name, position, format, content, properties, starred, template,
                   created_at, updated_at, last_opened_at, archived_at, deleted_at)
SELECT ?1, value->>'id', value->>'parent', value->>'name', value->>'position', value->>'format',
       value->>'content', value->>'properties', coalesce(value->>'starred', 0), coalesce(value->>'template', 0),
       unixepoch('subsec') * 1000, unixepoch('subsec') * 1000, value->>'lastOpenedAt',
       CASE WHEN value->>'status' = 'archived' THEN unixepoch('subsec') * 1000 END,
       CASE WHEN value->>'status' = 'trashed' THEN unixepoch('subsec') * 1000 END
FROM json_each(?2, '$.nodes') WHERE value->>'kind' = 'file'
ON CONFLICT(workspace_id, id) DO UPDATE SET
    parent_id = excluded.parent_id, name = excluded.name, position = excluded.position,
    format = excluded.format, content = excluded.content, properties = excluded.properties,
    starred = excluded.starred, template = excluded.template,
    updated_at = excluded.updated_at, last_opened_at = excluded.last_opened_at,
    archived_at = CASE WHEN excluded.archived_at IS NOT NULL THEN coalesce(notes.archived_at, excluded.archived_at) END,
    deleted_at = CASE WHEN excluded.deleted_at IS NOT NULL THEN coalesce(notes.deleted_at, excluded.deleted_at) END
WHERE (notes.parent_id, notes.name, notes.position, notes.format, notes.content, notes.properties, notes.starred,
       notes.template, notes.last_opened_at, notes.archived_at IS NULL, notes.deleted_at IS NULL)
   IS NOT (excluded.parent_id, excluded.name, excluded.position, excluded.format, excluded.content, excluded.properties,
           excluded.starred, excluded.template, excluded.last_opened_at, excluded.archived_at IS NULL, excluded.deleted_at IS NULL);

DELETE FROM notes WHERE workspace_id = ?1 AND id NOT IN (
    SELECT value->>'id' FROM json_each(?2, '$.nodes') WHERE value->>'kind' = 'file'
);

DELETE FROM folders WHERE workspace_id = ?1 AND id NOT IN (
    SELECT value->>'id' FROM json_each(?2, '$.nodes') WHERE value->>'kind' = 'folder'
);

INSERT OR IGNORE INTO tags (workspace_id, name)
SELECT ?1, tag.value FROM json_each(?2, '$.nodes') AS node, json_each(node.value, '$.tags') AS tag;

WITH incoming_tags AS (
    SELECT node.value->>'id' AS note_id, tag.value AS name
    FROM json_each(?2, '$.nodes') AS node, json_each(node.value, '$.tags') AS tag
)
DELETE FROM note_tags WHERE workspace_id = ?1 AND NOT EXISTS (
    SELECT 1 FROM incoming_tags WHERE note_id = note_tags.note_id AND note_tags.tag_name = name
);

INSERT OR IGNORE INTO note_tags (workspace_id, note_id, tag_name)
SELECT ?1, node.value->>'id', tag.value
FROM json_each(?2, '$.nodes') AS node, json_each(node.value, '$.tags') AS tag;

DELETE FROM tags WHERE workspace_id = ?1 AND NOT EXISTS (
    SELECT 1 FROM note_tags WHERE workspace_id = ?1 AND tag_name = tags.name
);

DELETE FROM editor_sessions WHERE workspace_id = ?1;

INSERT INTO editor_sessions (workspace_id, note_id, position, active)
SELECT ?1, value->>'id', key, value->>'active' FROM json_each(?2, '$.tabs');

DELETE FROM note_links WHERE workspace_id = ?1 AND source_id IN (
    SELECT value->>'id' FROM json_each(?2, '$.wikiChanges')
);

INSERT INTO note_links (workspace_id, source_id, start_offset, end_offset, target_id, target, alias, context)
SELECT ?1, link.value->>'sourceId', link.value->>'start', link.value->>'end',
       link.value->>'targetId', link.value->>'target', link.value->>'alias', link.value->>'context'
FROM json_each(?2, '$.wikiChanges') AS changed, json_each(changed.value, '$.links') AS link;

UPDATE workspaces SET wiki_index_ready = 1 WHERE id = ?1 AND json_type(?2, '$.wikiChanges') = 'array';
