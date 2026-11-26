DELETE FROM notes WHERE workspace_id = ?1 AND id NOT IN (
    SELECT value->>'id' FROM json_each(?2, '$.nodes') WHERE value->>'kind' = 'file'
);

DELETE FROM folders WHERE workspace_id = ?1 AND id NOT IN (
    SELECT value->>'id' FROM json_each(?2, '$.nodes') WHERE value->>'kind' = 'folder'
);

UPDATE tags SET managed = 0 WHERE workspace_id = ?1 AND managed = 1 AND json_type(?2, '$.managedTags') = 'array'
AND NOT EXISTS (SELECT 1 FROM json_each(?2, '$.managedTags') WHERE tags.name = value);

INSERT INTO tags (workspace_id, name, managed)
SELECT ?1, value, 1 FROM json_each(?2, '$.managedTags') WHERE json_type(?2, '$.managedTags') = 'array'
ON CONFLICT(workspace_id, name) DO UPDATE SET managed = 1, name = excluded.name;

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

DELETE FROM tags WHERE workspace_id = ?1 AND managed = 0 AND NOT EXISTS (
    SELECT 1 FROM note_tags WHERE workspace_id = ?1 AND tag_name = tags.name
);

DELETE FROM editor_sessions WHERE workspace_id = ?1;

INSERT INTO editor_sessions (workspace_id, note_id, position, active, pinned)
SELECT ?1, value->>'id', key, value->>'active', COALESCE(value->>'pinned', 0) FROM json_each(?2, '$.tabs');

DELETE FROM note_links WHERE workspace_id = ?1 AND source_id IN (
    SELECT value->>'id' FROM json_each(?2, '$.wikiChanges')
);

INSERT INTO note_links (workspace_id, source_id, start_offset, end_offset, target_id, target, alias, context)
SELECT ?1, link.value->>'sourceId', link.value->>'start', link.value->>'end',
       link.value->>'targetId', link.value->>'target', link.value->>'alias', link.value->>'context'
FROM json_each(?2, '$.wikiChanges') AS changed, json_each(changed.value, '$.links') AS link;

UPDATE workspaces SET wiki_index_ready = 1 WHERE id = ?1 AND json_type(?2, '$.wikiChanges') = 'array';
