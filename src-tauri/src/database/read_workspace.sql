SELECT json_object(
    'revision', revision,
    'legacyDigest', legacy_digest,
    'expanded', json(expanded),
    'managedTags', json((SELECT json_group_array(name) FROM (SELECT name FROM tags WHERE workspace_id = ?1 AND managed = 1 ORDER BY name))),
    'nodes', json((
        SELECT json_group_array(json(node)) FROM (
            SELECT position, json_object(
                'id', id, 'parent', parent_id, 'name', name, 'position', position, 'kind', 'folder',
                'status', CASE WHEN deleted_at IS NOT NULL THEN 'trashed' WHEN archived_at IS NOT NULL THEN 'archived' END
            ) AS node
            FROM folders WHERE workspace_id = ?1
            UNION ALL
            SELECT position, json_object(
                'id', id, 'parent', parent_id, 'name', name, 'position', position, 'kind', 'file', 'format', format,
                'tags', json((SELECT json_group_array(tags.name) FROM note_tags JOIN tags ON tags.workspace_id = note_tags.workspace_id AND tags.name = note_tags.tag_name WHERE note_tags.workspace_id = notes.workspace_id AND note_id = notes.id)),
                'status', CASE WHEN deleted_at IS NOT NULL THEN 'trashed' WHEN archived_at IS NOT NULL THEN 'archived' END,
                'content', content, 'properties', json(properties),
                'starred', starred, 'template', template, 'lastOpenedAt', last_opened_at
            ) AS node
            FROM notes WHERE workspace_id = ?1
            ORDER BY position
        )
    )),
    'wikiLinks', json(CASE WHEN wiki_index_ready = 1 THEN (
        SELECT json_group_array(json_object(
            'sourceId', source_id, 'start', start_offset, 'end', end_offset,
            'targetId', target_id, 'target', target, 'alias', alias, 'context', context
        ))
        FROM (
            SELECT * FROM note_links WHERE workspace_id = ?1 ORDER BY source_id, start_offset
        )
    ) END),
    'tabs', json((
        SELECT json_group_array(json_object('id', note_id, 'active', active, 'pinned', pinned))
        FROM (SELECT note_id, active, pinned FROM editor_sessions WHERE workspace_id = ?1 ORDER BY position)
    ))
)
FROM workspaces WHERE id = ?1
