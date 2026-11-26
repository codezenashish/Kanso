use super::{
    HistoryConfig, HistoryError, MS_PER_DAY, create_manual_snapshot_at, get_config, get_version,
    list_versions, prune_versions_at, restore_version_at, update_config_at,
};
use crate::database::attachments::{lifecycle, test_support_import_bytes};
use crate::database::migrations::WORKSPACE_MIGRATIONS;
use crate::database::workspace::{self, save_with_history_at};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use std::path::Path;
use std::time::Duration;
use tempfile::tempdir;

const TINY_PNG: &[u8] = b"\
    \x89\x50\x4e\x47\x0d\x0a\x1a\x0a\x00\x00\x00\x0d\x49\x48\x44\x52\
    \x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00\xb5\x1c\x0c\
    \x02\x00\x00\x00\x0b\x49\x44\x41\x54\x78\xda\x63\xfc\xff\x1f\x00\
    \x03\x03\x02\x00\xef\x97\xd5\x99\x00\x00\x00\x00\x49\x45\x4e\x44\
    \xae\x42\x60\x82";

async fn connect(directory: &Path) -> SqlitePool {
    SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(directory.join("kanso.db"))
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5)),
    )
    .await
    .unwrap()
}

fn note_node(
    id: &str,
    name: &str,
    position: i64,
    content: &str,
    properties: Value,
    status: Option<&str>,
) -> Value {
    let mut node = json!({
        "id": id,
        "name": name,
        "parent": null,
        "kind": "file",
        "position": position,
        "format": "markdown",
        "content": content,
        "properties": properties,
        "tags": []
    });
    if let Some(status) = status {
        node["status"] = json!(status);
    }
    node
}

fn snapshot_with_notes(nodes: Vec<Value>, tabs: Vec<Value>) -> Value {
    json!({
        "expanded": [],
        "nodes": nodes,
        "tabs": tabs,
        "wikiChanges": []
    })
}

#[test]
fn migrates_pre_version_workspace_and_persists_across_restarts() {
    tauri::async_runtime::block_on(async {
        let dir = tempdir().unwrap();
        let pool = connect(dir.path()).await;

        let pre_0005 = Migrator {
            migrations: std::borrow::Cow::Borrowed(&WORKSPACE_MIGRATIONS.migrations[..4]),
            ..Migrator::DEFAULT
        };
        pre_0005.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO workspaces (id, name, created_at, updated_at)
             VALUES ('local', 'Workspaces', 100, 100)",
        )
        .execute(&pool)
        .await
        .unwrap();
        workspace::write_nodes(
            &mut pool.acquire().await.unwrap(),
            &json!({
                "nodes": [
                    note_node("note-1", "Alpha.md", 0, "# Legacy", json!([{"name": "Tags", "value": "legacy"}]), None),
                    note_node("blank-1", "Blank.md", 1, "  \n ", json!([]), None),
                    note_node("archived-1", "Archived.md", 2, "Archived body", json!([]), Some("archived")),
                    note_node("trashed-1", "Trashed.md", 3, "Trashed body", json!([]), Some("trashed"))
                ]
            })
            .to_string(),
        )
        .await
        .unwrap();
        let att = test_support_import_bytes(&pool, dir.path(), "note-1", "pixel.png", TINY_PNG)
            .await
            .unwrap();
        let before_upgrade = workspace::load_before_tab_pins(&pool).await.unwrap().unwrap();
        pool.close().await;

        let pool = connect(dir.path()).await;
        WORKSPACE_MIGRATIONS.run(&pool).await.unwrap();
        assert_eq!(
            workspace::load(&pool).await.unwrap().unwrap(),
            before_upgrade
        );

        let content_v1 = format!("# Legacy\n![img](attachment:{})", att.id);
        let snap1 = snapshot_with_notes(
            vec![
                note_node(
                    "note-1",
                    "Alpha.md",
                    0,
                    &content_v1,
                    json!([{"name": "Tags", "value": "legacy"}]),
                    None,
                ),
                note_node("blank-1", "Blank.md", 1, "  \n ", json!([]), None),
                note_node(
                    "archived-1",
                    "Archived.md",
                    2,
                    "Archived body",
                    json!([]),
                    Some("archived"),
                ),
                note_node(
                    "trashed-1",
                    "Trashed.md",
                    3,
                    "Trashed body",
                    json!([]),
                    Some("trashed"),
                ),
            ],
            vec![json!({"id": "note-1", "active": 1})],
        );
        assert_eq!(
            save_with_history_at(&pool, Some(0), snap1, None, None, 1_000_000)
                .await
                .unwrap(),
            Some(1)
        );
        assert!(
            list_versions(&pool, "blank-1", None, None)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            list_versions(&pool, "archived-1", None, None)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            list_versions(&pool, "trashed-1", None, None)
                .await
                .unwrap()
                .is_empty()
        );

        let snap2 = snapshot_with_notes(
            vec![note_node(
                "note-1",
                "Alpha.md",
                0,
                "# Updated after interval",
                json!([{"name": "Tags", "value": "legacy, updated"}]),
                None,
            )],
            vec![json!({"id": "note-1", "active": 1})],
        );
        assert_eq!(
            save_with_history_at(&pool, Some(1), snap2, None, None, 1_300_000)
                .await
                .unwrap(),
            Some(2)
        );
        pool.close().await;

        let reopened = connect(dir.path()).await;
        WORKSPACE_MIGRATIONS.run(&reopened).await.unwrap();
        let versions = list_versions(&reopened, "note-1", None, None)
            .await
            .unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].created_at, 1_300_000);
        assert_eq!(versions[1].created_at, 1_000_000);
        assert_eq!(versions[1].attachment_ids, vec![att.id.clone()]);

        let detail = get_version(&reopened, "note-1", &versions[1].id)
            .await
            .unwrap();
        assert_eq!(detail.content, content_v1);
        assert_eq!(detail.attachment_ids, vec![att.id]);
        assert_eq!(
            get_config(&reopened).await.unwrap(),
            HistoryConfig::default()
        );
        reopened.close().await;
    });
}

#[test]
fn interval_gating_meaningful_changes_and_deduplication() {
    tauri::async_runtime::block_on(async {
        let dir = tempdir().unwrap();
        let pool = connect(dir.path()).await;
        WORKSPACE_MIGRATIONS.run(&pool).await.unwrap();

        let cfg = HistoryConfig {
            enabled: true,
            snapshot_interval_ms: 60_000,
            max_versions_per_note: 50,
            max_age_days: None,
        };

        // Initial blank save creates no snapshot.
        let s0 = snapshot_with_notes(
            vec![note_node("n1", "Note.md", 0, "", json!([]), None)],
            vec![],
        );
        assert_eq!(
            save_with_history_at(&pool, None, s0, None, None, 10_000)
                .await
                .unwrap(),
            Some(0)
        );
        assert!(
            list_versions(&pool, "n1", None, None)
                .await
                .unwrap()
                .is_empty()
        );

        update_config_at(&pool, cfg.clone(), false, 10_000)
            .await
            .unwrap();

        // First meaningful content creates baseline v1.
        let s1 = snapshot_with_notes(
            vec![note_node("n1", "Note.md", 0, "Hello", json!([]), None)],
            vec![],
        );
        assert_eq!(
            save_with_history_at(&pool, Some(0), s1, None, None, 20_000)
                .await
                .unwrap(),
            Some(1)
        );
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            1
        );

        // Rapid keystrokes within 60_000ms must NOT create snapshots on every save.
        let mut rev = 1;
        for (offset, text) in [(180, "Hello w"), (360, "Hello wo"), (59_999, "Hello wor")] {
            let s = snapshot_with_notes(
                vec![note_node("n1", "Note.md", 0, text, json!([]), None)],
                vec![],
            );
            rev = save_with_history_at(&pool, Some(rev), s, None, None, 20_000 + offset)
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            1
        );

        // At interval boundary (80_000), whitespace-only difference vs v1 ("Hello" vs "Hello  \n") is skipped.
        let s_ws = snapshot_with_notes(
            vec![note_node("n1", "Note.md", 0, "Hello  \n", json!([]), None)],
            vec![],
        );
        rev = save_with_history_at(&pool, Some(rev), s_ws, None, None, 80_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            1
        );

        // Renaming and changing tab/lastOpenedAt without content/property changes does not snapshot.
        let mut renamed = note_node("n1", "Renamed.md", 0, "Hello", json!([]), None);
        renamed["lastOpenedAt"] = json!(90_000);
        renamed["starred"] = json!(true);
        let s_meta = snapshot_with_notes(vec![renamed], vec![json!({"id": "n1", "active": 1})]);
        rev = save_with_history_at(&pool, Some(rev), s_meta, None, None, 90_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            1
        );

        // Meaningful content change after interval creates v2.
        let s2 = snapshot_with_notes(
            vec![note_node(
                "n1",
                "Renamed.md",
                0,
                "Hello world",
                json!([]),
                None,
            )],
            vec![],
        );
        rev = save_with_history_at(&pool, Some(rev), s2.clone(), None, None, 95_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            2
        );

        // Exact duplicate save long after interval is deduplicated.
        rev = save_with_history_at(&pool, Some(rev), s2, None, None, 500_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            2
        );

        // Property change after interval creates v3.
        let s3 = snapshot_with_notes(
            vec![note_node(
                "n1",
                "Renamed.md",
                0,
                "Hello world",
                json!([{"name": "Status", "value": "Draft"}]),
                None,
            )],
            vec![],
        );
        rev = save_with_history_at(&pool, Some(rev), s3, None, None, 600_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            3
        );

        // Manual snapshot while content is identical deduplicates; after edit it creates immediately.
        assert!(
            create_manual_snapshot_at(&pool, "n1", 600_100)
                .await
                .unwrap()
                .is_none()
        );
        let s4 = snapshot_with_notes(
            vec![note_node(
                "n1",
                "Renamed.md",
                0,
                "Hello world!",
                json!([{"name": "Status", "value": "Draft"}]),
                None,
            )],
            vec![],
        );
        rev = save_with_history_at(&pool, Some(rev), s4, None, None, 600_200)
            .await
            .unwrap()
            .unwrap();
        // Interval not elapsed for autosave, so still 3; manual checkpoint forces snapshot.
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            3
        );
        let manual = create_manual_snapshot_at(&pool, "n1", 600_300)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(manual.reason, "manual");
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            4
        );

        // Disabling history prevents new autosave snapshots while retaining existing ones.
        let disabled = HistoryConfig {
            enabled: false,
            ..cfg
        };
        let s5 = snapshot_with_notes(
            vec![note_node(
                "n1",
                "Renamed.md",
                0,
                "Disabled edit",
                json!([]),
                None,
            )],
            vec![],
        );
        assert!(
            save_with_history_at(&pool, Some(rev), s5, None, Some(disabled), 900_000)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            4
        );
        pool.close().await;
    });
}

#[test]
fn concurrent_edits_revision_conflict_and_failed_save_rollback() {
    tauri::async_runtime::block_on(async {
        let dir = tempdir().unwrap();
        let pool = connect(dir.path()).await;
        WORKSPACE_MIGRATIONS.run(&pool).await.unwrap();

        let s0 = snapshot_with_notes(
            vec![note_node("n1", "Doc.md", 0, "Version 1", json!([]), None)],
            vec![],
        );
        assert_eq!(
            save_with_history_at(&pool, None, s0, None, None, 1_000)
                .await
                .unwrap(),
            Some(0)
        );
        let att = test_support_import_bytes(&pool, dir.path(), "n1", "pic.png", TINY_PNG)
            .await
            .unwrap();

        // Stale revision must conflict and leave zero version/retention side effects.
        let stale = snapshot_with_notes(
            vec![note_node(
                "n1",
                "Doc.md",
                0,
                &format!("Stale ![](attachment:{})", att.id),
                json!([]),
                None,
            )],
            vec![],
        );
        assert_eq!(
            save_with_history_at(&pool, Some(99), stale, None, None, 400_000)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            1
        );
        let retained: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM retained_attachment_refs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(retained, 0);

        // Concurrent writers racing on revision 0: exactly one wins and one conflicts.
        let pool_a = pool.clone();
        let pool_b = pool.clone();
        let snap_a = snapshot_with_notes(
            vec![note_node("n1", "Doc.md", 0, "Branch A", json!([]), None)],
            vec![],
        );
        let snap_b = snapshot_with_notes(
            vec![note_node("n1", "Doc.md", 0, "Branch B", json!([]), None)],
            vec![],
        );
        let task_a = tauri::async_runtime::spawn(async move {
            save_with_history_at(&pool_a, Some(0), snap_a, None, None, 400_000).await
        });
        let task_b = tauri::async_runtime::spawn(async move {
            save_with_history_at(&pool_b, Some(0), snap_b, None, None, 400_000).await
        });
        let outcomes = [
            task_a.await.unwrap().unwrap(),
            task_b.await.unwrap().unwrap(),
        ];
        assert_eq!(outcomes.iter().filter(|r| r.is_some()).count(), 1);
        assert_eq!(outcomes.iter().filter(|r| r.is_none()).count(), 1);
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            2
        );

        // Failed save mid-transaction (missing parent FK) must roll back notes and versions.
        let mut broken = snapshot_with_notes(
            vec![
                note_node(
                    "n1",
                    "Doc.md",
                    0,
                    &format!("Should roll back ![](attachment:{})", att.id),
                    json!([]),
                    None,
                ),
                json!({
                    "id": "bad",
                    "name": "Bad.md",
                    "parent": "nonexistent-folder",
                    "kind": "file",
                    "position": 1,
                    "format": "markdown",
                    "content": "Broken"
                }),
            ],
            vec![],
        );
        assert!(
            save_with_history_at(&pool, Some(1), broken.clone(), None, None, 800_000)
                .await
                .is_err()
        );
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            2
        );
        let retained_after_fail: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM retained_attachment_refs")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(retained_after_fail, 0);

        // Revision conflict on restore leaves workspace and versions untouched.
        let versions = list_versions(&pool, "n1", None, None).await.unwrap();
        assert_eq!(
            restore_version_at(&pool, "n1", &versions[1].id, 999, true, 900_000)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            2
        );

        broken["nodes"].as_array_mut().unwrap().pop();
        let live_content: String = sqlx::query_scalar("SELECT content FROM notes WHERE id = 'n1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(live_content == "Branch A" || live_content == "Branch B");
        pool.close().await;
    });
}

#[test]
fn archived_trashed_deleted_and_attachment_retention_protection() {
    tauri::async_runtime::block_on(async {
        let dir = tempdir().unwrap();
        let pool = connect(dir.path()).await;
        WORKSPACE_MIGRATIONS.run(&pool).await.unwrap();

        let s0 = snapshot_with_notes(
            vec![
                note_node("n1", "Media.md", 0, "Initial", json!([]), None),
                note_node("n2", "Other.md", 1, "Other", json!([]), None),
            ],
            vec![json!({"id": "n1", "active": 1})],
        );
        assert_eq!(
            save_with_history_at(&pool, None, s0, None, None, 1_000)
                .await
                .unwrap(),
            Some(0)
        );
        let att = test_support_import_bytes(&pool, dir.path(), "n1", "img.png", TINY_PNG)
            .await
            .unwrap();

        // Save v2 referencing the attachment and tags.
        let v2_content = format!("Body with ![](attachment:{})", att.id);
        let s1 = snapshot_with_notes(
            vec![
                note_node(
                    "n1",
                    "Media.md",
                    0,
                    &v2_content,
                    json!([{"name": "Tags", "value": "media, keep"}]),
                    None,
                ),
                note_node("n2", "Other.md", 1, "Other", json!([]), None),
            ],
            vec![json!({"id": "n1", "active": 1})],
        );
        assert_eq!(
            save_with_history_at(&pool, Some(0), s1, None, None, 400_000)
                .await
                .unwrap(),
            Some(1)
        );

        // Save v3 removing the attachment and closing the tab -> note_attachments drops to 0.
        let s2 = snapshot_with_notes(
            vec![
                note_node(
                    "n1",
                    "Media.md",
                    0,
                    "Attachment removed",
                    json!([{"name": "Tags", "value": "plain"}]),
                    None,
                ),
                note_node("n2", "Other.md", 1, "Other", json!([]), None),
            ],
            vec![],
        );
        assert_eq!(
            save_with_history_at(&pool, Some(1), s2, None, None, 800_000)
                .await
                .unwrap(),
            Some(2)
        );

        // Attachment must remain protected by retained version history even though live note_count == 0.
        let storage = lifecycle::inspect(&pool, dir.path()).await.unwrap();
        assert_eq!(storage.unused_record_count, 0);
        assert_eq!(storage.unused_file_count, 0);
        assert_eq!(storage.attachments[0].note_count, 0);
        assert_eq!(storage.attachments[0].retained_count, 1);
        assert!(
            sqlx::query("DELETE FROM attachments WHERE id = ?")
                .bind(&att.id)
                .execute(&pool)
                .await
                .is_err()
        );

        // Archiving preserves versions and retained attachment refs.
        let s_archived = snapshot_with_notes(
            vec![
                note_node(
                    "n1",
                    "Media.md",
                    0,
                    "Attachment removed",
                    json!([{"name": "Tags", "value": "plain"}]),
                    Some("archived"),
                ),
                note_node("n2", "Other.md", 1, "Other", json!([]), None),
            ],
            vec![],
        );
        assert_eq!(
            save_with_history_at(&pool, Some(2), s_archived, None, None, 820_000)
                .await
                .unwrap(),
            Some(3)
        );
        let versions = list_versions(&pool, "n1", None, None).await.unwrap();
        assert_eq!(versions.len(), 3);

        // Trashing preserves versions and retained attachment refs, and blocks restore until untrashed.
        let s_trashed = snapshot_with_notes(
            vec![
                note_node(
                    "n1",
                    "Media.md",
                    0,
                    "Attachment removed",
                    json!([{"name": "Tags", "value": "plain"}]),
                    Some("trashed"),
                ),
                note_node("n2", "Other.md", 1, "Other", json!([]), None),
            ],
            vec![],
        );
        assert_eq!(
            save_with_history_at(&pool, Some(3), s_trashed, None, None, 840_000)
                .await
                .unwrap(),
            Some(4)
        );
        assert_eq!(
            restore_version_at(&pool, "n1", &versions[1].id, 4, true, 845_000)
                .await
                .unwrap_err(),
            HistoryError::NoteTrashed
        );
        assert_eq!(
            lifecycle::inspect(&pool, dir.path())
                .await
                .unwrap()
                .unused_record_count,
            0
        );

        // Untrash and restore the version that contained the attachment.
        let s_active = snapshot_with_notes(
            vec![
                note_node(
                    "n1",
                    "Media.md",
                    0,
                    "Attachment removed",
                    json!([{"name": "Tags", "value": "plain"}]),
                    None,
                ),
                note_node("n2", "Other.md", 1, "Other", json!([]), None),
            ],
            vec![],
        );
        assert_eq!(
            save_with_history_at(&pool, Some(4), s_active, None, None, 860_000)
                .await
                .unwrap(),
            Some(5)
        );

        // Save a recent edit within the 300s interval (no autosave snapshot yet),
        // then restore v2 and confirm the recent edit is preserved as a restore_checkpoint.
        let s_recent = snapshot_with_notes(
            vec![
                note_node(
                    "n1",
                    "Media.md",
                    0,
                    "Recent within-interval edit",
                    json!([{"name": "Tags", "value": "plain"}]),
                    None,
                ),
                note_node("n2", "Other.md", 1, "Other", json!([]), None),
            ],
            vec![],
        );
        assert_eq!(
            save_with_history_at(&pool, Some(5), s_recent, None, None, 900_000)
                .await
                .unwrap(),
            Some(6)
        );
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap().len(),
            3
        );

        let restored = restore_version_at(&pool, "n1", &versions[1].id, 6, true, 910_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.revision, 7);
        assert_eq!(restored.content, v2_content);
        assert_eq!(restored.tags, vec!["media", "keep"]);
        assert_eq!(restored.attachment_ids, vec![att.id.clone()]);
        assert!(restored.checkpoint_version_id.is_some());

        let wiki_ready: i64 = sqlx::query_scalar("SELECT wiki_index_ready FROM workspaces")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(wiki_ready, 0);

        let restored_versions = list_versions(&pool, "n1", None, None).await.unwrap();
        assert_eq!(restored_versions[0].reason, "restore_checkpoint");
        assert_eq!(restored_versions[0].preview, "Recent within-interval edit");

        // Permanently deleting n1 removes its versions and releases retained attachment references.
        let s_deleted = snapshot_with_notes(
            vec![note_node("n2", "Other.md", 0, "Other", json!([]), None)],
            vec![],
        );
        assert_eq!(
            save_with_history_at(&pool, Some(7), s_deleted, None, None, 2_200_000)
                .await
                .unwrap(),
            Some(8)
        );
        assert_eq!(
            list_versions(&pool, "n1", None, None).await.unwrap_err(),
            HistoryError::NoteNotFound
        );
        let left_refs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM retained_attachment_refs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left_refs, 0);

        let inspect_after_delete = lifecycle::inspect(&pool, dir.path()).await.unwrap();
        assert_eq!(inspect_after_delete.unused_record_count, 1);
        assert_eq!(inspect_after_delete.unused_file_count, 1);
        let cleaned = lifecycle::cleanup(&pool, dir.path(), inspect_after_delete.cleanup_token)
            .await
            .unwrap();
        assert_eq!(cleaned.attachments.len(), 0);
        assert_eq!(
            std::fs::read_dir(dir.path().join("attachments"))
                .unwrap()
                .count(),
            0
        );
        pool.close().await;
    });
}

#[test]
fn retention_boundaries_count_and_age() {
    tauri::async_runtime::block_on(async {
        let dir = tempdir().unwrap();
        let pool = connect(dir.path()).await;
        WORKSPACE_MIGRATIONS.run(&pool).await.unwrap();

        let s0 = snapshot_with_notes(
            vec![note_node("n1", "Retain.md", 0, "v1", json!([]), None)],
            vec![],
        );
        assert_eq!(
            save_with_history_at(&pool, None, s0, None, None, 1_000)
                .await
                .unwrap(),
            Some(0)
        );
        let att_old = test_support_import_bytes(&pool, dir.path(), "n1", "old.png", TINY_PNG)
            .await
            .unwrap();

        let cfg = HistoryConfig {
            enabled: true,
            snapshot_interval_ms: 1_000,
            max_versions_per_note: 5,
            max_age_days: None,
        };
        update_config_at(&pool, cfg.clone(), false, 1_000)
            .await
            .unwrap();
        assert_eq!(
            update_config_at(
                &pool,
                HistoryConfig {
                    max_versions_per_note: 0,
                    ..cfg.clone()
                },
                false,
                1_000
            )
            .await
            .unwrap_err(),
            HistoryError::InvalidConfig
        );

        // Save 4 more versions so total = 5 across days 0..=4. v2 retains att_old, v3..v5 do not.
        let mut rev = 0;
        let base_ts = 100 * MS_PER_DAY;
        let payloads = [
            (
                base_ts - 8 * MS_PER_DAY - 1,
                format!("v2 ![](attachment:{})", att_old.id),
            ),
            (base_ts - 7 * MS_PER_DAY, "v3".to_owned()),
            (base_ts - 2 * MS_PER_DAY, "v4".to_owned()),
            (base_ts, "v5".to_owned()),
        ];
        for (ts, body) in payloads {
            let snap = snapshot_with_notes(
                vec![note_node("n1", "Retain.md", 0, &body, json!([]), None)],
                vec![],
            );
            rev = save_with_history_at(&pool, Some(rev), snap, None, None, ts)
                .await
                .unwrap()
                .unwrap();
        }
        let all = list_versions(&pool, "n1", None, None).await.unwrap();
        assert_eq!(all.len(), 5);

        // Age boundary: max_age_days = 7 at now = base_ts prunes < base_ts - 7d (v1 and v2), keeps == base_ts - 7d (v3).
        let pruned_age = prune_versions_at(&pool, Some("n1"), None, Some(7), base_ts)
            .await
            .unwrap();
        assert_eq!(pruned_age.deleted_versions, 2);
        assert_eq!(pruned_age.released_attachment_refs, 1);

        let after_age = list_versions(&pool, "n1", None, None).await.unwrap();
        assert_eq!(after_age.len(), 3);
        assert_eq!(after_age[2].preview, "v3");

        // Count boundary: update_config_at with max_versions_per_note = 2 and apply_retention = true.
        let tightened = HistoryConfig {
            max_versions_per_note: 2,
            ..cfg
        };
        update_config_at(&pool, tightened, true, base_ts)
            .await
            .unwrap();
        pool.close().await;

        let reopened = connect(dir.path()).await;
        WORKSPACE_MIGRATIONS.run(&reopened).await.unwrap();
        let after_count = list_versions(&reopened, "n1", None, None).await.unwrap();
        assert_eq!(after_count.len(), 2);
        assert_eq!(after_count[0].preview, "v5");
        assert_eq!(after_count[1].preview, "v4");
        assert_eq!(
            get_config(&reopened).await.unwrap().max_versions_per_note,
            2
        );
        reopened.close().await;
    });
}
