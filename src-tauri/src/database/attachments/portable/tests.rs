use super::{AttachmentError, export, read_manifest, restore};
use crate::database::{
    attachments::{
        load_attachment, storage, test_support_import_bytes,
        tests::{existing_workspace, import},
    },
    workspace,
};
use std::fs;
use tempfile::tempdir;

#[test]
fn portable_notes_use_relative_paths_and_restore_works_after_interruption() {
    tauri::async_runtime::block_on(async {
        let (source, source_pool) = existing_workspace().await;
        let text_path = source.path().join("Read me.txt");
        fs::write(&text_path, "a shared attachment").unwrap();
        let text = import(&source_pool, source.path(), "first", &text_path)
            .await
            .unwrap();
        let guide = test_support_import_bytes(
            &source_pool,
            source.path(),
            "first",
            "Guide.pdf",
            b"%PDF-1.4\n%%EOF\n",
        )
        .await
        .unwrap();
        let content = format!(
            "# Example\n\n[File][reference] · [Guide](attachment:{} \"caption\")\n\n[reference]: <attachment&colon;{}>\n\n```md\n[example](attachment:{})\n```\n",
            guide.id, text.id, guide.id,
        );
        sqlx::query("UPDATE notes SET content = ? WHERE id = 'first'")
            .bind(&content)
            .execute(&source_pool)
            .await
            .unwrap();
        sqlx::query("UPDATE notes SET content = ?, deleted_at = 1 WHERE id = 'second'")
            .bind(format!("[Shared](attachment:{})", text.id))
            .execute(&source_pool)
            .await
            .unwrap();
        let destination = tempdir().unwrap();
        let backup = export(
            &source_pool,
            source.path(),
            destination.path().to_path_buf(),
        )
        .await
        .unwrap();
        assert!(backup.is_dir());
        let manifest_path = backup.join("workspace.json");
        let saved = read_manifest(&manifest_path).unwrap();
        assert_eq!(saved.attachments.len(), 2);
        assert!(saved.nodes.iter().any(|note| note["content"] == content));
        let exported_path = fs::read_dir(backup.join("notes"))
            .unwrap()
            .find_map(|entry| {
                let path = entry.unwrap().path();
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .ends_with("-First.md")
                    .then_some(path)
            })
            .unwrap();
        let portable = fs::read_to_string(&exported_path).unwrap();
        for file in [&text, &guide] {
            let name = storage::blob_name(&file.digest, &file.mime_type).unwrap();
            let relative = format!("../attachments/{name}");
            assert!(portable.contains(&relative), "{portable}");
            assert!(exported_path.parent().unwrap().join(relative).is_file());
        }
        assert!(portable.contains(&format!("[example](attachment:{})", guide.id)));

        let (target, target_pool) = existing_workspace().await;
        let existing = workspace::load(&target_pool).await.unwrap().unwrap();
        let last = saved.attachments.last().unwrap();
        let missing = backup
            .join("attachments")
            .join(storage::blob_name(&last.digest, &last.mime_type).unwrap());
        let bytes = fs::read(&missing).unwrap();
        fs::remove_file(&missing).unwrap();
        assert!(matches!(
            restore(&target_pool, target.path(), manifest_path.clone()).await,
            Err(AttachmentError::ManagedFileMissing)
        ));
        assert_eq!(
            workspace::load(&target_pool).await.unwrap().unwrap(),
            existing
        );
        let indexed: i64 = sqlx::query_scalar("SELECT count(*) FROM attachments")
            .fetch_one(&target_pool)
            .await
            .unwrap();
        assert_eq!(indexed, 0);
        let pending_files = fs::read_dir(target.path().join("attachments"))
            .unwrap()
            .count();
        assert_eq!(pending_files, 1);

        fs::write(missing, bytes).unwrap();
        assert_eq!(
            restore(&target_pool, target.path(), manifest_path)
                .await
                .unwrap(),
            3
        );
        let snapshot = workspace::load(&target_pool).await.unwrap().unwrap();
        let nodes = snapshot["nodes"].as_array().unwrap();
        assert!(nodes.contains(&existing["nodes"][0]));
        let recovered = nodes
            .iter()
            .find(|note| note["content"] == content)
            .unwrap();
        let recovered_id = recovered["id"].as_str().unwrap();
        assert_ne!(recovered_id, "first");
        let (_, path) = load_attachment(&target_pool, target.path(), recovered_id, &guide.id)
            .await
            .unwrap();
        assert_eq!(fs::read(path).unwrap(), b"%PDF-1.4\n%%EOF\n");
        let trashed = nodes
            .iter()
            .find(|note| note["name"] == "Second.md" && note["status"] == "trashed")
            .unwrap();
        let (_, path) = load_attachment(
            &target_pool,
            target.path(),
            trashed["id"].as_str().unwrap(),
            &text.id,
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "a shared attachment");
    });
}

#[test]
fn backup_restores_history_pins_and_keeps_exact_pre_restore_content() {
    use crate::database::history::{create_manual_snapshot_at, list_versions, restore_version_at};
    tauri::async_runtime::block_on(async {
        let (source, source_pool) = existing_workspace().await;
        let attachment = test_support_import_bytes(
            &source_pool,
            source.path(),
            "first",
            "History only.txt",
            b"retained bytes",
        )
        .await
        .unwrap();
        let historical = format!("[Historical file](attachment:{})", attachment.id);
        sqlx::query("UPDATE notes SET content = ? WHERE id = 'first'")
            .bind(&historical)
            .execute(&source_pool)
            .await
            .unwrap();
        let original = create_manual_snapshot_at(&source_pool, "first", 1000)
            .await
            .unwrap()
            .unwrap();
        sqlx::query("UPDATE notes SET content = 'Current content' WHERE id = 'first'")
            .execute(&source_pool)
            .await
            .unwrap();
        create_manual_snapshot_at(&source_pool, "first", 2000)
            .await
            .unwrap()
            .unwrap();
        sqlx::query("DELETE FROM editor_sessions")
            .execute(&source_pool)
            .await
            .unwrap();

        let export_folder = tempdir().unwrap();
        let backup = export(
            &source_pool,
            source.path(),
            export_folder.path().to_path_buf(),
        )
        .await
        .unwrap();
        let manifest_path = backup.join("workspace.json");
        let manifest = read_manifest(&manifest_path).unwrap();
        assert_eq!(manifest.version, 2);
        assert_eq!(manifest.history.len(), 2);
        assert!(
            backup
                .join("attachments")
                .join(storage::blob_name(&attachment.digest, &attachment.mime_type).unwrap())
                .is_file()
        );

        let (target, target_pool) = existing_workspace().await;
        let collision = test_support_import_bytes(
            &target_pool,
            target.path(),
            "first",
            "Different file.txt",
            b"different bytes",
        )
        .await
        .unwrap();
        sqlx::query("DELETE FROM note_attachments WHERE attachment_id = ?")
            .bind(&collision.id)
            .execute(&target_pool)
            .await
            .unwrap();
        sqlx::query("UPDATE attachments SET id = ? WHERE id = ?")
            .bind(&attachment.id)
            .bind(&collision.id)
            .execute(&target_pool)
            .await
            .unwrap();

        restore(&target_pool, target.path(), manifest_path)
            .await
            .unwrap();
        let snapshot = workspace::load(&target_pool).await.unwrap().unwrap();
        let note = snapshot["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|note| note["content"] == "Current content")
            .unwrap();
        let note_id = note["id"].as_str().unwrap();
        let versions = list_versions(&target_pool, note_id, None, None)
            .await
            .unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[1].created_at, original.created_at);
        let restored_id = versions[1].attachment_ids[0].clone();
        assert_ne!(restored_id, attachment.id);
        let pinned: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM retained_attachment_refs WHERE attachment_id = ?)",
        )
        .bind(&restored_id)
        .fetch_one(&target_pool)
        .await
        .unwrap();
        assert!(pinned);

        let exact = "Current content \n";
        sqlx::query("UPDATE notes SET content = ? WHERE id = ?")
            .bind(exact)
            .bind(note_id)
            .execute(&target_pool)
            .await
            .unwrap();
        let revision = snapshot["revision"].as_i64().unwrap();
        assert!(
            restore_version_at(
                &target_pool,
                note_id,
                &versions[1].id,
                revision - 1,
                true,
                3000
            )
            .await
            .unwrap()
            .is_none()
        );
        let result =
            restore_version_at(&target_pool, note_id, &versions[1].id, revision, true, 3000)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            result.content,
            historical.replace(&attachment.id, &restored_id)
        );
        let checkpoint: String =
            sqlx::query_scalar("SELECT content FROM note_versions WHERE id = ?")
                .bind(result.checkpoint_version_id.unwrap())
                .fetch_one(&target_pool)
                .await
                .unwrap();
        assert_eq!(checkpoint, exact);
        let (_, path) = load_attachment(&target_pool, target.path(), note_id, &restored_id)
            .await
            .unwrap();
        assert_eq!(fs::read(path).unwrap(), b"retained bytes");
    });
}
