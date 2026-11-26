use super::{AttachmentError, cleanup, inspect, reconcile};
use crate::database::{
    attachments::{
        load_attachment,
        tests::{existing_workspace, import},
    },
    workspace,
};
use serde_json::json;
use std::fs;

#[test]
fn cleanup_guards_shared_trashed_undoable_and_retained_attachments() {
    tauri::async_runtime::block_on(async {
        let (directory, pool) = existing_workspace().await;
        let directory = directory.path();
        let source = directory.join("shared.txt");
        fs::write(&source, "shared bytes").unwrap();
        let shared = import(&pool, directory, "first", &source).await.unwrap();
        let retained = directory.join("retained.txt");
        fs::write(&retained, "version bytes").unwrap();
        let retained = import(&pool, directory, "first", &retained).await.unwrap();
        sqlx::query("INSERT INTO retained_attachment_refs VALUES ('local', 'fixture-1', ?)")
            .bind(&retained.id)
            .execute(&pool)
            .await
            .unwrap();

        let snapshot = |status, content: String, open| {
            json!({
                "expanded": [],
                "nodes": [
                    {"id":"first", "name":"First.md", "parent":null, "kind":"file", "position":0, "format":"markdown", "content":""},
                    {"id":"second", "name":"Second.md", "parent":null, "kind":"file", "position":1, "format":"markdown", "content":content, "status":status}
                ],
                "tabs": if open { json!([{ "id": "first", "active": 1 }]) } else { json!([]) },
                "wikiChanges": []
            })
        };
        let link = format!("[Shared](attachment&colon;{})", shared.id);
        assert_eq!(
            workspace::save(
                &pool,
                Some(0),
                snapshot("trashed", link.clone(), true),
                None
            )
            .await
            .unwrap(),
            Some(1)
        );
        let summary = inspect(&pool, directory).await.unwrap();
        assert_eq!(summary.file_count, 2);
        assert_eq!(summary.unused_file_count, 0);
        assert_eq!(
            summary
                .attachments
                .iter()
                .find(|item| item.attachment.id == shared.id)
                .unwrap()
                .note_count,
            2
        );
        assert!(
            load_attachment(&pool, directory, "second", &shared.id)
                .await
                .is_ok()
        );

        assert_eq!(
            workspace::save(&pool, Some(1), snapshot("active", link, false), None)
                .await
                .unwrap(),
            Some(2)
        );
        assert_eq!(
            inspect(&pool, directory).await.unwrap().unused_file_count,
            0
        );
        assert!(
            load_attachment(&pool, directory, "second", &shared.id)
                .await
                .is_ok()
        );

        assert_eq!(
            workspace::save(
                &pool,
                Some(2),
                snapshot("active", String::new(), false),
                None
            )
            .await
            .unwrap(),
            Some(3)
        );
        let summary = inspect(&pool, directory).await.unwrap();
        assert_eq!(summary.unused_file_count, 1);
        assert_eq!(summary.unused_record_count, 1);

        let alias_path = directory.join("alias.txt");
        fs::copy(source, &alias_path).unwrap();
        let alias = import(&pool, directory, "second", &alias_path)
            .await
            .unwrap();
        let update = format!("[Alias](attachment:{})", alias.id);
        assert_eq!(
            workspace::save(&pool, Some(3), snapshot("active", update, false), None)
                .await
                .unwrap(),
            Some(4)
        );
        assert!(matches!(
            cleanup(&pool, directory, summary.cleanup_token).await,
            Err(AttachmentError::CleanupChanged)
        ));
        let summary = inspect(&pool, directory).await.unwrap();
        assert_eq!(summary.unused_file_count, 0);
        assert_eq!(summary.unused_record_count, 1);
        let summary = cleanup(&pool, directory, summary.cleanup_token)
            .await
            .unwrap();
        assert_eq!(summary.file_count, 2);
        assert!(
            load_attachment(&pool, directory, "second", &alias.id)
                .await
                .is_ok()
        );

        // A crash after metadata commit can leave an unindexed digest file.
        let (_, path) = load_attachment(&pool, directory, "second", &alias.id)
            .await
            .unwrap();
        sqlx::query("UPDATE notes SET content = '' WHERE id = 'second'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM attachments WHERE id = ?")
            .bind(&alias.id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(path.is_file());
        let summary = inspect(&pool, directory).await.unwrap();
        assert_eq!(summary.unused_file_count, 1);
        assert_eq!(
            cleanup(&pool, directory, summary.cleanup_token)
                .await
                .unwrap()
                .file_count,
            1
        );
        assert!(!path.exists());
        let mut connection = pool.acquire().await.unwrap();
        reconcile(&mut connection).await.unwrap();
        let pinned: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attachments WHERE id = ?)")
                .bind(&retained.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(pinned);
    });
}
