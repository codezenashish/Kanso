use super::attachments::{
    AttachmentError, lifecycle, load_attachment, portable, test_support_import_bytes,
};
use super::history::{
    HistoryConfig, create_manual_snapshot_at, get_config, get_version, list_versions,
    prune_versions_at, restore_version_at, update_config_at,
};
use super::migrations::WORKSPACE_MIGRATIONS;
use super::workspace::{self, save_with_history_at};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use std::fs;
use std::path::Path;
use std::time::Duration;
use tempfile::tempdir;

const TINY_PNG: &[u8] = b"\
    \x89\x50\x4e\x47\x0d\x0a\x1a\x0a\x00\x00\x00\x0d\x49\x48\x44\x52\
    \x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00\xb5\x1c\x0c\
    \x02\x00\x00\x00\x0b\x49\x44\x41\x54\x78\xda\x63\xfc\xff\x1f\x00\
    \x03\x03\x02\x00\xef\x97\xd5\x99\x00\x00\x00\x00\x49\x45\x4e\x44\
    \xae\x42\x60\x82";

async fn connect_db(path: &Path) -> SqlitePool {
    SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5)),
    )
    .await
    .unwrap()
}

#[test]
fn copies_existing_v1_workspace_migrates_and_recovers_from_failures() {
    tauri::async_runtime::block_on(async {
        let source_dir = tempdir().unwrap();
        let source_db_path = source_dir.path().join("kanso.db");
        let source_pool = connect_db(&source_db_path).await;

        let v1_only = Migrator {
            migrations: std::borrow::Cow::Borrowed(&WORKSPACE_MIGRATIONS.migrations[..1]),
            ..Migrator::DEFAULT
        };
        v1_only.run(&source_pool).await.unwrap();
        sqlx::query(
            "INSERT INTO workspaces (id, name, created_at, updated_at, expanded)
             VALUES ('local', 'Workspaces', 100, 100, '[\"folder-1\"]')",
        )
        .execute(&source_pool)
        .await
        .unwrap();

        let seeded_nodes = json!({
            "nodes": [
                {
                    "id": "folder-1",
                    "name": "Projects",
                    "parent": null,
                    "kind": "folder",
                    "position": 0
                },
                {
                    "id": "note-md",
                    "name": "Roadmap.md",
                    "parent": "folder-1",
                    "kind": "file",
                    "position": 0,
                    "format": "markdown",
                    "content": "# Roadmap\n\nSee [[Config.yaml]]",
                    "properties": [
                        { "name": "Tags", "value": "kanso, release" },
                        { "name": "Owner", "value": "Local" }
                    ],
                    "tags": ["kanso", "release"],
                    "starred": true,
                    "template": false
                },
                {
                    "id": "note-yaml",
                    "name": "Config.yaml",
                    "parent": null,
                    "kind": "file",
                    "position": 1,
                    "format": "yaml",
                    "content": "version: 1\nmode: local\n"
                },
                {
                    "id": "note-archived",
                    "name": "Old.md",
                    "parent": null,
                    "kind": "file",
                    "position": 2,
                    "format": "markdown",
                    "content": "Archived content",
                    "status": "archived"
                },
                {
                    "id": "note-trashed",
                    "name": "Deleted.md",
                    "parent": null,
                    "kind": "file",
                    "position": 3,
                    "format": "markdown",
                    "content": "Trash content",
                    "status": "trashed"
                }
            ]
        });
        workspace::write_nodes(&mut source_pool.acquire().await.unwrap(), &seeded_nodes.to_string())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO tags (workspace_id, name) VALUES ('local', 'kanso'), ('local', 'release');
             INSERT INTO note_tags (workspace_id, note_id, tag_name) VALUES ('local', 'note-md', 'kanso'), ('local', 'note-md', 'release');
             INSERT INTO editor_sessions (workspace_id, note_id, position, active) VALUES ('local', 'note-md', 0, 1), ('local', 'note-yaml', 1, 0);",
        )
        .execute(&source_pool)
        .await
        .unwrap();
        let v1_note_count: i64 = sqlx::query_scalar("SELECT count(*) FROM notes")
            .fetch_one(&source_pool)
            .await
            .unwrap();
        assert_eq!(v1_note_count, 4);
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&source_pool)
            .await
            .unwrap();
        source_pool.close().await;

        // Copy the existing database file (simulating upgrading an existing user's workspace copy).
        let copy_dir = tempdir().unwrap();
        let copy_db_path = copy_dir.path().join("kanso.db");
        fs::copy(&source_db_path, &copy_db_path).unwrap();

        let copy_pool = connect_db(&copy_db_path).await;
        WORKSPACE_MIGRATIONS.run(&copy_pool).await.unwrap();

        // Running migrations again is idempotent and preserves every node, property, tag, and tab.
        WORKSPACE_MIGRATIONS.run(&copy_pool).await.unwrap();
        let migrated_snapshot = workspace::load(&copy_pool).await.unwrap().unwrap();
        assert_eq!(migrated_snapshot["nodes"].as_array().unwrap().len(), 5);
        assert_eq!(
            migrated_snapshot["nodes"][1]["content"],
            "# Roadmap\n\nSee [[Config.yaml]]"
        );
        assert_eq!(
            migrated_snapshot["nodes"][1]["tags"],
            json!(["kanso", "release"])
        );
        assert_eq!(migrated_snapshot["nodes"][3]["status"], "archived");
        assert_eq!(migrated_snapshot["nodes"][4]["status"], "trashed");
        assert_eq!(
            migrated_snapshot["tabs"],
            json!([
                { "id": "note-md", "active": 1, "pinned": 0 },
                { "id": "note-yaml", "active": 0, "pinned": 0 }
            ])
        );
        assert_eq!(migrated_snapshot["expanded"], json!(["folder-1"]));

        let config = get_config(&copy_pool).await.unwrap();
        assert!(config.enabled);
        assert_eq!(config.snapshot_interval_ms, 300_000);
        assert_eq!(config.max_versions_per_note, 50);

        // Failure recovery: invalid snapshot rolls back cleanly without corrupting workspace or revision.
        let bad_snapshot = json!({
            "expanded": ["folder-1"],
            "nodes": [
                {
                    "id": "broken-node",
                    "name": "Broken.md",
                    "parent": "missing-parent",
                    "kind": "file",
                    "position": 0
                }
            ],
            "tabs": []
        });
        let revision = migrated_snapshot["revision"].as_i64().unwrap();
        assert!(
            save_with_history_at(&copy_pool, Some(revision), bad_snapshot, None, None, 500_000)
                .await
                .is_err()
        );
        assert_eq!(
            workspace::load(&copy_pool).await.unwrap().unwrap(),
            migrated_snapshot
        );

        // Concurrent writer revision mismatch returns Ok(None) without losing existing data.
        assert_eq!(
            save_with_history_at(
                &copy_pool,
                Some(revision + 99),
                migrated_snapshot.clone(),
                None,
                None,
                500_000,
            )
            .await
            .unwrap(),
            None
        );
        copy_pool.close().await;
    });
}

#[test]
fn end_to_end_attachments_versions_backup_restore_and_cleanup_recovery() {
    tauri::async_runtime::block_on(async {
        let dir = tempdir().unwrap();
        let pool = connect_db(&dir.path().join("kanso.db")).await;
        WORKSPACE_MIGRATIONS.run(&pool).await.unwrap();

        // Initialize workspace with one Markdown note.
        let initial = json!({
            "expanded": [],
            "nodes": [
                {
                    "id": "n-main",
                    "name": "Engineering.md",
                    "parent": null,
                    "kind": "file",
                    "position": 0,
                    "format": "markdown",
                    "content": "# Initial\n\nPlain draft",
                    "properties": [{ "name": "Tags", "value": "v1" }],
                    "tags": ["v1"]
                }
            ],
            "tabs": [{ "id": "n-main", "active": true }]
        });
        let rev0 = save_with_history_at(&pool, None, initial, None, None, 1_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            list_versions(&pool, "n-main", None, None)
                .await
                .unwrap()
                .len(),
            1
        );

        // Import PNG + PDF and test deduplication/filename collision metadata.
        let png = test_support_import_bytes(&pool, dir.path(), "n-main", "diagram.png", TINY_PNG)
            .await
            .unwrap();
        let png_dup =
            test_support_import_bytes(&pool, dir.path(), "n-main", "diagram.png", TINY_PNG)
                .await
                .unwrap();
        assert_eq!(png.id, png_dup.id);
        let pdf = test_support_import_bytes(
            &pool,
            dir.path(),
            "n-main",
            "spec.pdf",
            b"%PDF-1.4\n%%EOF\n",
        )
        .await
        .unwrap();

        // Update note to reference both attachments and save after interval.
        let v2_content = format!(
            "# Initial\n\n![Diagram](attachment:{} \"System\")\n\n[Spec](attachment:{})",
            png.id, pdf.id
        );
        let s2 = json!({
            "expanded": [],
            "nodes": [
                {
                    "id": "n-main",
                    "name": "Engineering.md",
                    "parent": null,
                    "kind": "file",
                    "position": 0,
                    "format": "markdown",
                    "content": v2_content,
                    "properties": [{ "name": "Tags", "value": "v2, media" }],
                    "tags": ["v2", "media"]
                }
            ],
            "tabs": [{ "id": "n-main", "active": true }]
        });
        let rev1 = save_with_history_at(&pool, Some(rev0), s2, None, None, 400_000)
            .await
            .unwrap()
            .unwrap();

        // Whitespace-only edit is deduplicated and creates no extra snapshot.
        let s2_ws = json!({
            "expanded": [],
            "nodes": [
                {
                    "id": "n-main",
                    "name": "Engineering.md",
                    "parent": null,
                    "kind": "file",
                    "position": 0,
                    "format": "markdown",
                    "content": format!("  {v2_content}  \n"),
                    "properties": [{ "name": "Tags", "value": "v2, media" }],
                    "tags": ["v2", "media"]
                }
            ],
            "tabs": [{ "id": "n-main", "active": true }]
        });
        let rev2 = save_with_history_at(&pool, Some(rev1), s2_ws, None, None, 800_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            list_versions(&pool, "n-main", None, None)
                .await
                .unwrap()
                .len(),
            2
        );

        // Remove PDF from current note after interval; v2 history still retains PDF.
        let v3_content = format!("# Current\n\n![Diagram](attachment:{})", png.id);
        let s3 = json!({
            "expanded": [],
            "nodes": [
                {
                    "id": "n-main",
                    "name": "Engineering.md",
                    "parent": null,
                    "kind": "file",
                    "position": 0,
                    "format": "markdown",
                    "content": v3_content,
                    "properties": [{ "name": "Tags", "value": "v3" }],
                    "tags": ["v3"]
                }
            ],
            "tabs": [{ "id": "n-main", "active": true }]
        });
        let rev3 = save_with_history_at(&pool, Some(rev2), s3, None, None, 1_200_000)
            .await
            .unwrap()
            .unwrap();

        let inspection = lifecycle::inspect(&pool, dir.path()).await.unwrap();
        assert_eq!(inspection.unused_record_count, 0);
        assert_eq!(inspection.unused_file_count, 0);

        // Closing tabs drops provisional import protection for unreferenced files, so the old token becomes stale.
        let extra =
            test_support_import_bytes(&pool, dir.path(), "n-main", "orphan.txt", b"temporary")
                .await
                .unwrap();
        let s3_closed = json!({
            "expanded": [],
            "nodes": [
                {
                    "id": "n-main",
                    "name": "Engineering.md",
                    "parent": null,
                    "kind": "file",
                    "position": 0,
                    "format": "markdown",
                    "content": v3_content,
                    "properties": [{ "name": "Tags", "value": "v3" }],
                    "tags": ["v3"]
                }
            ],
            "tabs": []
        });
        let _rev4 = save_with_history_at(&pool, Some(rev3), s3_closed, None, None, 1_210_000)
            .await
            .unwrap()
            .unwrap();
        let err = lifecycle::cleanup(&pool, dir.path(), inspection.cleanup_token)
            .await
            .err()
            .unwrap();
        assert_eq!(err, AttachmentError::CleanupChanged);

        // Fresh inspection removes only the unreferenced orphan while retaining both PNG and PDF.
        let fresh_inspection = lifecycle::inspect(&pool, dir.path()).await.unwrap();
        assert_eq!(fresh_inspection.unused_record_count, 1);
        assert_eq!(fresh_inspection.unused_file_count, 1);
        let after_clean = lifecycle::cleanup(&pool, dir.path(), fresh_inspection.cleanup_token)
            .await
            .unwrap();
        assert_eq!(after_clean.unused_record_count, 0);
        assert_eq!(after_clean.attachments.len(), 2);
        assert!(
            after_clean
                .attachments
                .iter()
                .all(|item| item.attachment.id != extra.id)
        );

        // Export portable backup, verify manifest v2 + relative links + versions, then restore into clean DB.
        let backup_root = tempdir().unwrap();
        let backup_dir = portable::export(&pool, dir.path(), backup_root.path().to_path_buf())
            .await
            .unwrap();
        let manifest_path = backup_dir.join("workspace.json");
        let manifest: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        assert_eq!(manifest["version"], 2);
        assert_eq!(manifest["attachments"].as_array().unwrap().len(), 2);
        assert_eq!(manifest["history"].as_array().unwrap().len(), 3);

        // Failure & repair check on source managed file:
        // 1) Corrupted bytes are detected as ManagedFileInvalid and not silently overwritten.
        // 2) Removing the corrupted/missing blob yields ManagedFileMissing, and re-importing repairs it preserving ID.
        let (_, png_path) = load_attachment(&pool, dir.path(), "n-main", &png.id)
            .await
            .unwrap();
        fs::write(&png_path, b"corrupted").unwrap();
        assert_eq!(
            load_attachment(&pool, dir.path(), "n-main", &png.id)
                .await
                .unwrap_err(),
            AttachmentError::ManagedFileInvalid
        );
        assert_eq!(
            test_support_import_bytes(&pool, dir.path(), "n-main", "diagram.png", TINY_PNG)
                .await
                .unwrap_err(),
            AttachmentError::ManagedFileInvalid
        );
        fs::remove_file(&png_path).unwrap();
        assert_eq!(
            load_attachment(&pool, dir.path(), "n-main", &png.id)
                .await
                .unwrap_err(),
            AttachmentError::ManagedFileMissing
        );
        let repaired = test_support_import_bytes(&pool, dir.path(), "n-main", "diagram.png", TINY_PNG)
            .await
            .unwrap();
        assert_eq!(repaired.id, png.id);
        let (_, restored_path) = load_attachment(&pool, dir.path(), "n-main", &png.id)
            .await
            .unwrap();
        assert_eq!(fs::read(restored_path).unwrap(), TINY_PNG);

        // Restore portable backup into a second initialized workspace, then restore v2 version on the recovered note.
        let target_dir = tempdir().unwrap();
        let target_pool = connect_db(&target_dir.path().join("kanso.db")).await;
        WORKSPACE_MIGRATIONS.run(&target_pool).await.unwrap();
        let target_seed = json!({
            "expanded": [],
            "nodes": [
                {
                    "id": "existing-note",
                    "name": "Existing.md",
                    "parent": null,
                    "kind": "file",
                    "position": 0,
                    "format": "markdown",
                    "content": "Already here"
                }
            ],
            "tabs": []
        });
        save_with_history_at(&target_pool, None, target_seed, None, None, 1_000)
            .await
            .unwrap()
            .unwrap();
        let recovered_notes = portable::restore(&target_pool, target_dir.path(), manifest_path)
            .await
            .unwrap();
        assert_eq!(recovered_notes, 1);

        let target_snapshot = workspace::load(&target_pool).await.unwrap().unwrap();
        let target_rev = target_snapshot["revision"].as_i64().unwrap();
        let mut nodes = target_snapshot["nodes"].as_array().unwrap().clone();
        let recovered_idx = nodes
            .iter()
            .position(|node| node["name"] == "Engineering.md")
            .unwrap();
        let recovered_note_id = nodes[recovered_idx]["id"].as_str().unwrap().to_owned();

        // Save a quick within-interval edit so restore_version_at creates a restore_checkpoint.
        nodes[recovered_idx]["content"] = json!("# Current\n\nUnsnapshotted recent edit");
        let target_rev = save_with_history_at(
            &target_pool,
            Some(target_rev),
            json!({ "expanded": [], "nodes": nodes, "tabs": [] }),
            None,
            None,
            1_250_000,
        )
        .await
        .unwrap()
        .unwrap();

        let versions = list_versions(&target_pool, &recovered_note_id, None, None)
            .await
            .unwrap();
        assert_eq!(versions.len(), 3);
        let v2_summary = versions.iter().find(|v| v.attachment_ids.len() == 2).unwrap();
        let v2_detail = get_version(&target_pool, &recovered_note_id, &v2_summary.id)
            .await
            .unwrap();
        assert_eq!(v2_detail.attachment_ids.len(), 2);

        let restored_v2 = restore_version_at(
            &target_pool,
            &recovered_note_id,
            &v2_summary.id,
            target_rev,
            true,
            2_000_000,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(restored_v2.attachment_ids.len(), 2);
        assert!(restored_v2.checkpoint_version_id.is_some());
        for att_id in &restored_v2.attachment_ids {
            let (_, path) =
                load_attachment(&target_pool, target_dir.path(), &recovered_note_id, att_id)
                    .await
                    .unwrap();
            assert!(path.is_file());
        }

        // Update retention config & prune versions with attachment release check.
        update_config_at(
            &target_pool,
            HistoryConfig {
                enabled: true,
                snapshot_interval_ms: 60_000,
                max_versions_per_note: 2,
                max_age_days: None,
            },
            true,
            2_000_000,
        )
        .await
        .unwrap();
        assert_eq!(
            list_versions(&target_pool, &recovered_note_id, None, None)
                .await
                .unwrap()
                .len(),
            2
        );

        // Save manual snapshot and prune down to 1 version via explicit prune_versions_at.
        let _ = create_manual_snapshot_at(&target_pool, &recovered_note_id, 2_100_000)
            .await
            .unwrap();
        let pruned = prune_versions_at(&target_pool, Some(&recovered_note_id), Some(1), None, 2_100_000)
            .await
            .unwrap();
        assert!(pruned.deleted_versions >= 1);

        pool.close().await;
        target_pool.close().await;
    });
}

#[test]
fn template_note_preserves_properties_and_valid_attachments_across_template_removal() {
    tauri::async_runtime::block_on(async {
        let dir = tempdir().unwrap();
        let pool = connect_db(&dir.path().join("kanso.db")).await;
        WORKSPACE_MIGRATIONS.run(&pool).await.unwrap();

        let seed = json!({
            "expanded": [],
            "nodes": [
                {
                    "id": "tpl-1",
                    "name": "Project Brief.md",
                    "parent": null,
                    "kind": "file",
                    "position": 0,
                    "format": "markdown",
                    "content": "# Brief",
                    "template": true
                }
            ],
            "tabs": [{ "id": "tpl-1", "active": 1, "pinned": 0 }]
        });
        let rev0 = save_with_history_at(&pool, None, seed, None, None, 1_000)
            .await
            .unwrap()
            .unwrap();

        let valid_png = test_support_import_bytes(&pool, dir.path(), "tpl-1", "cover.png", TINY_PNG)
            .await
            .unwrap();
        let missing_id = "99999999-9999-4999-8999-999999999999";
        let template_content = format!(
            "# Brief\n\n![Cover](attachment:{})\n\n![Broken](attachment:{missing_id})\n",
            valid_png.id
        );
        let template_props = json!([
            { "name": "Owner", "value": "Platform" },
            { "name": "Tags", "value": "brief, spec" }
        ]);

        let with_template = json!({
            "expanded": ["f-parent", "f-nested"],
            "nodes": [
                {
                    "id": "tpl-1",
                    "name": "Project Brief.md",
                    "parent": null,
                    "kind": "file",
                    "position": 0,
                    "format": "markdown",
                    "content": template_content,
                    "properties": template_props,
                    "tags": ["brief", "spec"],
                    "template": true
                },
                {
                    "id": "f-parent",
                    "name": "Work",
                    "parent": null,
                    "kind": "folder",
                    "position": 1
                },
                {
                    "id": "f-nested",
                    "name": "Q4",
                    "parent": "f-parent",
                    "kind": "folder",
                    "position": 0
                },
                {
                    "id": "note-from-tpl",
                    "name": "Launch Plan.md",
                    "parent": "f-nested",
                    "kind": "file",
                    "position": 0,
                    "format": "markdown",
                    "content": template_content,
                    "properties": template_props,
                    "tags": ["brief", "spec"],
                    "template": false
                }
            ],
            "tabs": [{ "id": "note-from-tpl", "active": 1, "pinned": 0 }]
        });
        let rev1 = save_with_history_at(&pool, Some(rev0), with_template, None, None, 400_000)
            .await
            .unwrap()
            .unwrap();

        // Only valid attachment references are linked in note_attachments for the derived note.
        assert!(
            load_attachment(&pool, dir.path(), "note-from-tpl", &valid_png.id)
                .await
                .is_ok()
        );
        assert!(matches!(
            load_attachment(&pool, dir.path(), "note-from-tpl", missing_id).await,
            Err(AttachmentError::AttachmentNotFound)
        ));

        // Removing the original template note keeps the derived note's attachment protected from cleanup.
        let without_template = json!({
            "expanded": ["f-parent", "f-nested"],
            "nodes": [
                {
                    "id": "f-parent",
                    "name": "Work",
                    "parent": null,
                    "kind": "folder",
                    "position": 0
                },
                {
                    "id": "f-nested",
                    "name": "Q4",
                    "parent": "f-parent",
                    "kind": "folder",
                    "position": 0
                },
                {
                    "id": "note-from-tpl",
                    "name": "Launch Plan.md",
                    "parent": "f-nested",
                    "kind": "file",
                    "position": 0,
                    "format": "markdown",
                    "content": template_content,
                    "properties": template_props,
                    "tags": ["brief", "spec"],
                    "template": false
                }
            ],
            "tabs": [{ "id": "note-from-tpl", "active": 1, "pinned": 0 }]
        });
        let _rev2 = save_with_history_at(&pool, Some(rev1), without_template, None, None, 800_000)
            .await
            .unwrap()
            .unwrap();

        let storage = lifecycle::inspect(&pool, dir.path()).await.unwrap();
        assert_eq!(storage.unused_file_count, 0);
        assert_eq!(storage.attachments[0].note_count, 1);
        assert!(
            load_attachment(&pool, dir.path(), "note-from-tpl", &valid_png.id)
                .await
                .is_ok()
        );

        let loaded = workspace::load(&pool).await.unwrap().unwrap();
        let derived = loaded["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "note-from-tpl")
            .unwrap();
        assert_eq!(derived["parent"], "f-nested");
        assert_eq!(derived["properties"], template_props);
        assert_eq!(derived["template"], 0);

        pool.close().await;
    });
}

