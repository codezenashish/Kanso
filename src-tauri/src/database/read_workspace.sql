SELECT json_object(
    'revision', revision,
    'legacyDigest', legacy_digest,
    'expanded', json(expanded),
    'nodes', json((
        SELECT json_group_array(json(node)) FROM (
            SELECT position, json_object(
                'id', id, 'parent', parent_id, 'name', name, 'kind', 'folder',
                'status', CASE WHEN deleted_at IS NOT NULL THEN 'trashed' WHEN archived_at IS NOT NULL THEN 'archived' END
            ) AS node
            FROM folders WHERE workspace_id = ?1
            UNION ALL
            SELECT position, json_object(
                'id', id, 'parent', parent_id, 'name', name, 'kind', 'file',
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
        SELECT json_group_array(json_object('id', note_id, 'active', active))
        FROM (SELECT note_id, active FROM editor_sessions WHERE workspace_id = ?1 ORDER BY position)
    ))
)
FROM workspaces WHERE id = ?1
